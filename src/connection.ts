// Stateless connection layer.
//
// Every operation on a stored IBKR connection routes through
// `withClient(connectionId, async (client) => ...)`. We:
//   1. Load the previously-persisted session state from Firestore
//      (ibkr_connections/{id}/session/state).
//   2. Construct an IbkrClient from it.
//   3. If the session is dead (no cookies, or `tickle` fails) we
//      fetch the credential from Secret Manager, run `signIn()`, and
//      save the fresh state — all transparent to the caller.
//   4. Run the caller's function.
//   5. Persist the (possibly-updated) state back to Firestore.
//   6. Return the function's result.
//
// The process holds NO long-lived state between calls. Two gateway
// instances calling this concurrently for the same connection will
// race only on the Firestore write — the cost is one extra signIn
// (cheap; sub-10s) if a session is reinitialised twice. Acceptable
// for v1; we can add a Firestore-transaction lock later if needed.
//
// SECURITY: The activation code + password live in Secret Manager and
// are read on-demand. They are dropped from local variables before
// we return to the caller (no `cred` reference retained after
// signIn).

import { FieldValue, Timestamp } from "@google-cloud/firestore";
import {
  connectionsCol,
  sessionDocRef,
  type ConnectionDoc,
  type SessionDoc,
} from "./firestore.js";
import { fetchCredential, type IbkrCredential } from "./secrets.js";
import { IbkrClient, IbkrError, EmailVerificationRequiredError, type IbkrClientState } from "../lib/ibkr/index.js";
import { logError } from "./logging.js";

export class EmailVerificationNeededError extends Error {
  constructor(public readonly connectionId: string) {
    super(
      `IBKR sent a new-device verification code to the account email for ${connectionId}. ` +
      `Retry with the 6-digit code from the email.`,
    );
    this.name = "EmailVerificationNeededError";
  }
}

export class ConnectionNotFoundError extends Error {
  constructor(public readonly connectionId: string) {
    super(`connection ${connectionId} not found`);
    this.name = "ConnectionNotFoundError";
  }
}

export class CredentialRejectedError extends Error {
  constructor(public readonly connectionId: string, cause: string) {
    super(`IBKR rejected the stored credentials for ${connectionId}: ${cause}`);
    this.name = "CredentialRejectedError";
  }
}

/**
 * Run `fn` against an authenticated IbkrClient for `connectionId`.
 *
 * The function should treat the client as ephemeral — it's discarded
 * once `fn` resolves. Any mutation to client state (cookies refreshed
 * by IBKR, current account changed, etc.) is persisted automatically.
 *
 * Throws ConnectionNotFoundError if the Firestore connection doc is
 * missing. Throws CredentialRejectedError if the stored credentials
 * fail to sign in (the doc's credential_status is set to "rejected"
 * as a side effect).
 */
export interface WithClientOptions {
  /** 6-digit code from IBKR's new-device verification email; only
   *  consulted when a cold sign-in fires the challenge. */
  emailCode?: string | null;
}

export async function withClient<T>(
  connectionId: string,
  fn: (client: IbkrClient) => Promise<T>,
  opts: WithClientOptions = {}
): Promise<T> {
  // 1. Load the connection doc — gives us the mode and confirms ownership
  //    chain is sound. Caller is responsible for any account-scoping check.
  const connSnap = await connectionsCol.doc(connectionId).get();
  if (!connSnap.exists) throw new ConnectionNotFoundError(connectionId);
  const conn = connSnap.data() as ConnectionDoc;

  // 2. Load any saved session state. Missing is fine — we'll signIn cold.
  const sessSnap = await sessionDocRef(connectionId).get();
  const savedState = sessSnap.exists
    ? ((sessSnap.data() as SessionDoc).state as unknown as IbkrClientState)
    : null;

  const client = new IbkrClient({ state: savedState });

  // 3. Decide whether the session is usable. If we have cookies, try
  //    a tickle — that's the cheapest live-or-dead probe. If we have no
  //    cookies, or tickle fails with auth-ish error, we cold-signIn.
  let needSignIn = !client.isSignedIn();
  let tickleErr: string | null = null;
  if (!needSignIn) {
    try {
      await client.tickle();
    } catch (e) {
      needSignIn = true;
      tickleErr = e instanceof Error ? e.message : String(e);
    }
  }

  if (needSignIn) {
    await signInFresh(client, connectionId, conn, opts.emailCode ?? null);
    // Persist the freshly-minted session immediately (before we run fn)
    // so a crash in fn doesn't lose the signIn work.
    await persistState(connectionId, client.getState(), { tickleOk: true });
  } else if (tickleErr) {
    // Cold-tickle reported failure but we recovered — record that.
    await persistState(connectionId, client.getState(), { tickleOk: false });
  } else {
    // Existing session was reused as-is. Touch last_tickle_at.
    await persistState(connectionId, client.getState(), { tickleOk: true });
  }

  // 4. Run the caller's work.
  let result: T;
  try {
    result = await fn(client);
  } finally {
    // 5. Always save whatever state ended up on the client (cookies
    //    rotated, current account changed, accounts cache refreshed,
    //    etc.). Best-effort — if Firestore is down we still return the
    //    caller's result so they don't lose it.
    persistState(connectionId, client.getState(), { tickleOk: true }).catch((e) => {
      // eslint-disable-next-line no-console
      console.error(`persist session for ${connectionId} failed:`, (e as Error).message);
    });
  }
  return result;
}

// ---------------------------------------------------------------------------

async function signInFresh(
  client: IbkrClient,
  connectionId: string,
  conn: ConnectionDoc,
  emailCode: string | null,
): Promise<void> {
  // Fetch the master credentials. The variable is null'd at the end of
  // this function so the plaintext lives in memory only for the
  // duration of the signIn call (§6.1).
  let cred: IbkrCredential | null = await fetchCredential(connectionId);
  const mode = cred.mode ?? conn.mode ?? "paper";
  const totpSecret = mode === "live" ? cred.totp_secret ?? null : null;

  try {
    await client.signIn({
      username: cred.username,
      password: cred.password,
      mode,
      totpSecret,
      emailCode,
    });
  } catch (e) {
    // New-device challenge: bubble up unchanged. Don't mark the
    // credential as rejected — credentials ARE valid, IBKR just wants
    // a one-time verification step before completing the sign-in.
    if (e instanceof EmailVerificationRequiredError) {
      cred = null; // drop plaintext before throwing across the boundary
      throw new EmailVerificationNeededError(connectionId);
    }
    const msg = e instanceof Error ? e.message : String(e);
    // Mark the credential as rejected so the console UI surfaces it.
    await connectionsCol
      .doc(connectionId)
      .update({
        credential_status: "rejected",
        credential_checked_at: FieldValue.serverTimestamp(),
      })
      .catch(() => undefined);
    // Persist for later debugging — minus any credential plaintext
    // (the only context we record is mode + the host/path we landed
    // on, which IbkrError's stage/status convey).
    await logError({
      source: "connection",
      connectionId,
      code: "CREDENTIAL_REJECTED",
      error: e,
      context: { phase: "signIn", mode },
    });
    if (e instanceof IbkrError) throw new CredentialRejectedError(connectionId, msg);
    throw new CredentialRejectedError(connectionId, msg);
  } finally {
    cred = null; // drop the plaintext
  }

  // SignIn succeeded — mark credential valid + populate ibkr_account_id
  // if the connection didn't have one yet (single-account auto-pin).
  const update: Record<string, unknown> = {
    credential_status: "valid",
    credential_checked_at: FieldValue.serverTimestamp(),
  };
  const currentAcct = client.getCurrentAccount();
  if (!conn.ibkr_account_id && currentAcct) {
    update.ibkr_account_id = currentAcct;
  }
  await connectionsCol.doc(connectionId).update(update).catch(() => undefined);
}

async function persistState(
  connectionId: string,
  state: IbkrClientState,
  { tickleOk }: { tickleOk: boolean }
): Promise<void> {
  await sessionDocRef(connectionId).set(
    {
      state: state as unknown as Record<string, unknown>,
      updated_at: FieldValue.serverTimestamp() as unknown as Timestamp,
      last_tickle_at: FieldValue.serverTimestamp() as unknown as Timestamp,
      last_tickle_ok: tickleOk,
    },
    { merge: true }
  );
}
