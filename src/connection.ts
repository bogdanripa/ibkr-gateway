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
  constructor(
    public readonly connectionId: string,
    /** True if a previous code was just rejected — UI should hint that
     *  the user needs the *fresh* email IBKR just sent, not an old one. */
    public readonly previousRejected: boolean = false,
  ) {
    super(
      previousRejected
        ? `IBKR rejected the verification token for ${connectionId}. The previous code was wrong or expired — request a fresh one.`
        : `IBKR sent a new-device verification code to the account email for ${connectionId}. Retry with the 6-digit code from the email.`,
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
      // The flag lives on the error instance — propagate so the UI
      // can render "previous code rejected, paste the FRESH one".
      const previousRejected =
        (e as Error & { previousRejected?: boolean }).previousRejected === true;
      throw new EmailVerificationNeededError(connectionId, previousRejected);
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

// ===========================================================================
// Persistent sign-in controller — keeps the Playwright browser alive
// across the user-input wait for IBKR's email verification token.
//
// Rationale: each cold signIn() opens its own Chromium, runs through
// /sso/Login → TOTP, and lands on /restricted/ where IBKR sends a
// verification email. The email token is bound to *that browser
// session*; if we close the browser between asking the user for the
// code and resuming, IBKR has already invalidated the token by the
// time the user pastes it back (a fresh sign-in attempt makes IBKR
// send a NEW email and silently expire the previous one).
//
// So for the Test flow we keep the browser open. The map below tracks
// in-flight sign-ins per connection; the API layer uses
// startTestSignIn() to spawn one and resumeWithCode() to feed it the
// code without re-auth'ing.
//
// All other gateway operations (Positions, MCP tools, future /v1/api/*)
// keep using withClient and are unaffected — they only sign in when
// the saved session is dead, never with verification needs.
// ===========================================================================

export type TestSignInOutcome =
  | { kind: "success"; ibkr_accounts: string[] }
  | { kind: "failure"; error: string; code?: string };

interface PendingSignIn {
  connectionId: string;
  /** Resolved by /verify with the next code to try, or null to abort. */
  provideCode: (code: string | null) => void;
  /** Awaitable that flips to true the next time the browser asks the
   *  caller for a (possibly fresh) code — signals to the API layer
   *  that it should return 202 again. */
  nextNeedsCode: () => Promise<{ previousRejected: boolean }>;
  /** Resolved when the sign-in completes (success or terminal failure). */
  outcome: Promise<TestSignInOutcome>;
  /** True after the most recent code was reported rejected by IBKR. */
  previousRejected: boolean;
  createdAt: number;
}

const pendingSignIns = new Map<string, PendingSignIn>();
const STALE_PENDING_MS = 5 * 60 * 1000; // GC pending sign-ins older than 5 min

/**
 * Start a fresh sign-in for the connection. Returns immediately with
 * one of two race outcomes:
 *   · `{ kind: 'done', outcome }` — the sign-in completed without
 *     needing verification (clean Test).
 *   · `{ kind: 'awaiting-code', previousRejected: false }` — the
 *     browser hit /restricted/ and parked waiting for a code. The
 *     pending sign-in is now registered; /verify resumes it.
 *
 * Caller should ABORT any prior pending sign-in for this connection
 * before calling — we evict the old one defensively here too.
 */
export async function startTestSignIn(connectionId: string): Promise<
  | { kind: "done"; outcome: TestSignInOutcome }
  | { kind: "awaiting-code"; previousRejected: boolean }
> {
  // Sweep stale pending entries before adding a new one.
  gcPending();
  // Abort any in-flight for this connection.
  const existing = pendingSignIns.get(connectionId);
  if (existing) existing.provideCode(null);

  const connSnap = await connectionsCol.doc(connectionId).get();
  if (!connSnap.exists) throw new ConnectionNotFoundError(connectionId);
  const conn = connSnap.data() as ConnectionDoc;

  // Build the code-handoff promises.
  type CodeRequest = { previousRejected: boolean; resolve: (code: string | null) => void };
  const codeRequests: CodeRequest[] = [];
  let needsCodeWaiters: Array<(r: { previousRejected: boolean }) => void> = [];

  const onNeedCode = async ({ previousRejected }: { previousRejected: boolean }) => {
    // Signal anyone waiting via nextNeedsCode().
    const waiters = needsCodeWaiters;
    needsCodeWaiters = [];
    for (const w of waiters) w({ previousRejected });
    // Park until /verify feeds a code.
    return new Promise<string | null>((resolve) => {
      codeRequests.push({ previousRejected, resolve });
    });
  };

  const provideCode = (code: string | null) => {
    const r = codeRequests.shift();
    if (r) r.resolve(code);
  };
  const nextNeedsCode = () =>
    new Promise<{ previousRejected: boolean }>((resolve) => {
      needsCodeWaiters.push(resolve);
    });

  // Load any saved cookies / state so signIn can pre-load them.
  const sessSnap = await sessionDocRef(connectionId).get();
  const savedState = sessSnap.exists
    ? ((sessSnap.data() as SessionDoc).state as unknown as IbkrClientState)
    : null;
  const client = new IbkrClient({ state: savedState });

  let cred: IbkrCredential | null = await fetchCredential(connectionId);
  const mode = cred.mode ?? conn.mode ?? "paper";
  const totpSecret = mode === "live" ? cred.totp_secret ?? null : null;

  const outcome: Promise<TestSignInOutcome> = (async () => {
    try {
      await client.signIn({
        username: cred!.username,
        password: cred!.password,
        mode,
        totpSecret,
        onNeedCode,
      });
      // Persist the freshly-minted session.
      await persistState(connectionId, client.getState(), { tickleOk: true });
      // Pull accounts for the response.
      const accounts = await client.getAccounts();
      await connectionsCol.doc(connectionId).update({
        credential_status: "valid",
        credential_checked_at: FieldValue.serverTimestamp(),
        ...(accounts.length === 1 && !conn.ibkr_account_id
          ? { ibkr_account_id: (accounts[0].accountId ?? accounts[0].id) as string }
          : {}),
      }).catch(() => undefined);
      return {
        kind: "success",
        ibkr_accounts: accounts.map((a) => (a.accountId ?? a.id) as string),
      };
    } catch (e) {
      // EmailVerificationRequiredError that actually escapes means
      // the user aborted (provideCode(null)) or hit the retry cap.
      if (e instanceof EmailVerificationRequiredError) {
        return { kind: "failure", error: "Verification aborted or exceeded retry limit", code: "EMAIL_VERIFICATION_ABORTED" };
      }
      const msg = e instanceof Error ? e.message : String(e);
      await connectionsCol.doc(connectionId).update({
        credential_status: "rejected",
        credential_checked_at: FieldValue.serverTimestamp(),
      }).catch(() => undefined);
      logError({
        source: "connection",
        connectionId,
        code: "CREDENTIAL_REJECTED",
        error: e,
        context: { phase: "test-signin", mode },
      }).catch(() => undefined);
      return { kind: "failure", error: msg, code: "CREDENTIAL_REJECTED" };
    } finally {
      cred = null;
      pendingSignIns.delete(connectionId);
    }
  })();

  const pending: PendingSignIn = {
    connectionId,
    provideCode,
    nextNeedsCode,
    outcome,
    previousRejected: false,
    createdAt: Date.now(),
  };
  pendingSignIns.set(connectionId, pending);

  // Race: did the sign-in finish without needing a code, or did it
  // pause asking for one?
  const firstNeed = pending.nextNeedsCode();
  const race = await Promise.race([
    outcome.then((o) => ({ kind: "done" as const, outcome: o })),
    firstNeed.then((r) => ({ kind: "awaiting-code" as const, previousRejected: r.previousRejected })),
  ]);
  if (race.kind === "done") {
    // Sign-in completed before any verification need — the map entry
    // is already cleaned up by the finally block.
    return race;
  }
  pending.previousRejected = race.previousRejected;
  return race;
}

/**
 * Feed an email verification code to a parked sign-in. Resumes the
 * SAME browser session, so IBKR's emailed token is still valid.
 * Races the outcome against the next verification need so we can
 * tell the API which to surface.
 */
export async function resumeWithCode(
  connectionId: string,
  code: string | null,
): Promise<
  | { kind: "done"; outcome: TestSignInOutcome }
  | { kind: "awaiting-code"; previousRejected: boolean }
  | { kind: "not-pending" }
> {
  const pending = pendingSignIns.get(connectionId);
  if (!pending) return { kind: "not-pending" };

  const nextNeed = pending.nextNeedsCode();
  pending.provideCode(code);
  if (code == null) {
    // Abort — wait for the outcome to settle (signIn will throw).
    return { kind: "done", outcome: await pending.outcome };
  }

  const race = await Promise.race([
    pending.outcome.then((o) => ({ kind: "done" as const, outcome: o })),
    nextNeed.then((r) => ({ kind: "awaiting-code" as const, previousRejected: r.previousRejected })),
  ]);
  if (race.kind === "awaiting-code") {
    pending.previousRejected = race.previousRejected;
  }
  return race;
}

function gcPending(): void {
  const cutoff = Date.now() - STALE_PENDING_MS;
  for (const [id, p] of pendingSignIns.entries()) {
    if (p.createdAt < cutoff) {
      p.provideCode(null); // signals an abort
      pendingSignIns.delete(id);
    }
  }
}
