// Console API. All routes require Firebase Auth (see auth.ts).
// Mounted at /console/api in src/index.ts.

import { Router, type Request, type Response, type NextFunction } from "express";
import { FieldValue } from "@google-cloud/firestore";
import { requireFirebaseAuth } from "./auth.js";
import {
  apiKeysCol,
  connectionsCol,
  type ConnectionDoc,
} from "../firestore.js";
import {
  createCredential,
  updateCredential,
  destroyCredential,
} from "../secrets.js";
import { generateApiKey } from "../apikeys.js";
import { withClient, CredentialRejectedError } from "../connection.js";

export const consoleApi = Router();
consoleApi.use(requireFirebaseAuth);

// JSON body parser scoped to this router.
consoleApi.use((req, _res, next) => {
  if (req.is("application/json")) {
    let buf = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { buf += c; });
    req.on("end", () => {
      try { req.body = buf ? JSON.parse(buf) : {}; next(); }
      catch { next(new Error("invalid JSON body")); }
    });
  } else {
    next();
  }
});

// ---------------------------------------------------------------------------
// Me
// ---------------------------------------------------------------------------

consoleApi.get("/me", (req, res) => {
  res.json(req.consoleUser);
});

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

consoleApi.get("/connections", async (req, res) => {
  const { account_id } = req.consoleUser!;
  const snap = await connectionsCol
    .where("account_id", "==", account_id)
    .orderBy("created_at", "desc")
    .get();

  res.json({
    connections: snap.docs.map((d) => publicConnection(d.id, d.data())),
  });
});

consoleApi.post("/connections", async (req, res) => {
  const { account_id } = req.consoleUser!;
  const parsed = parseConnectionBody(req.body, { requireMode: true });
  if ("error" in parsed) {
    res.status(400).json(parsed);
    return;
  }
  const { ibkr_username, ibkr_password, ibkr_totp_secret, label } = parsed;
  // parseConnectionBody with {requireMode:true} guarantees mode is set.
  const mode = parsed.mode!;

  // 1. Create the Firestore document first (with a placeholder credential
  //    ref). We need its id to name the secret.
  const docRef = await connectionsCol.add({
    account_id,
    ibkr_account_id: null,
    label: label ?? null,
    mode,
    created_at: FieldValue.serverTimestamp() as never,
    ibkr_credential_ref: "", // patched below once we know the resource name
    credential_status: "unknown",
    credential_checked_at: null,
  });

  // 2. Store credentials in Secret Manager.
  let credentialRef: string;
  try {
    credentialRef = await createCredential(docRef.id, {
      username: ibkr_username,
      password: ibkr_password,
      mode,
      ...(ibkr_totp_secret ? { totp_secret: ibkr_totp_secret } : {}),
    });
  } catch (err) {
    // Roll back: delete the Firestore doc so we don't leave orphans.
    await docRef.delete().catch(() => undefined);
    res.status(500).json({
      error: "could not store credential",
      detail: (err as Error).message,
    });
    return;
  }

  // 3. Patch the doc with the real ref.
  await docRef.update({ ibkr_credential_ref: credentialRef });

  const after = await docRef.get();
  res.status(201).json(publicConnection(docRef.id, after.data()!));
});

consoleApi.put("/connections/:id/credentials", async (req, res) => {
  const conn = await loadOwnedConnection(req, res);
  if (!conn) return;

  // Mode is immutable after creation — the new credentials must match
  // the existing mode (this would refuse to put live creds into a
  // paper connection or vice-versa, even if the caller tried).
  const existingMode = conn.data.mode ?? "paper"; // legacy docs default to paper
  const parsed = parseConnectionBody(req.body, { requireMode: false });
  if ("error" in parsed) {
    res.status(400).json(parsed);
    return;
  }
  if (parsed.mode && parsed.mode !== existingMode) {
    res.status(400).json({
      error: `mode is immutable on this connection (${existingMode}). ` +
        `Delete it and create a new live/paper connection instead.`,
    });
    return;
  }
  const { ibkr_username, ibkr_password, ibkr_totp_secret } = parsed;
  // For live we always need the activation code (even on rotation) —
  // either the caller supplied a new one OR the connection already had
  // one in Secret Manager. Easier rule: require the caller to re-send
  // it on rotation. It is the master key; cycling it is a feature, not
  // a bug.
  if (existingMode === "live" && !ibkr_totp_secret) {
    res.status(400).json({
      error: "activation code is required for live-mode credential rotation",
    });
    return;
  }

  try {
    await updateCredential(conn.id, {
      username: ibkr_username,
      password: ibkr_password,
      mode: existingMode,
      ...(ibkr_totp_secret ? { totp_secret: ibkr_totp_secret } : {}),
    });
  } catch (err) {
    res.status(500).json({
      error: "could not rotate credential",
      detail: (err as Error).message,
    });
    return;
  }

  await connectionsCol.doc(conn.id).update({
    credential_status: "unknown",
    credential_checked_at: null,
  });

  res.json({ ok: true });
});

consoleApi.delete("/connections/:id", async (req, res) => {
  const conn = await loadOwnedConnection(req, res);
  if (!conn) return;

  // Destroy the Secret Manager secret first (§6.1: offboarding that leaves
  // credentials in Secret Manager is a defect).
  await destroyCredential(conn.id).catch(() => undefined);

  // Revoke any keys belonging to the connection.
  const keys = await apiKeysCol
    .where("ibkr_connection_id", "==", conn.id)
    .get();
  for (const doc of keys.docs) {
    if (doc.get("revoked_at") == null) {
      await doc.ref.update({ revoked_at: FieldValue.serverTimestamp() });
    }
  }

  await connectionsCol.doc(conn.id).delete();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Test connection — sign in (or reuse the saved session) and confirm IBKR
// accepts us. No Docker, no IBeam — uses the stateless connection layer
// in src/connection.ts which is the same path /v1/api/* will use.
// ---------------------------------------------------------------------------

consoleApi.post("/connections/:id/test", async (req, res) => {
  const conn = await loadOwnedConnection(req, res);
  if (!conn) return;

  try {
    const accounts = await withClient(conn.id, async (client) => client.getAccounts());
    res.json({
      ok: true,
      ibkr_accounts: accounts.map((a) => (a.accountId ?? a.id) as string),
    });
  } catch (err) {
    if (err instanceof CredentialRejectedError) {
      res.status(400).json({
        ok: false,
        code: "CREDENTIAL_REJECTED",
        error: err.message,
      });
      return;
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Positions — a read-only deep smoke that exercises everything the
// gateway's runtime path does: session load → tickle/signIn → portfolio
// fetch. The UI exposes this as a button next to Test.
// ---------------------------------------------------------------------------

consoleApi.get("/connections/:id/positions", async (req, res) => {
  const conn = await loadOwnedConnection(req, res);
  if (!conn) return;
  try {
    const snapshot = await withClient(conn.id, async (client) => client.getPositions());
    res.json({ ok: true, snapshot });
  } catch (err) {
    if (err instanceof CredentialRejectedError) {
      res.status(400).json({ ok: false, code: "CREDENTIAL_REJECTED", error: err.message });
      return;
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

consoleApi.get("/connections/:id/api-keys", async (req, res) => {
  const conn = await loadOwnedConnection(req, res);
  if (!conn) return;

  const snap = await apiKeysCol
    .where("ibkr_connection_id", "==", conn.id)
    .orderBy("created_at", "desc")
    .get();

  res.json({
    api_keys: snap.docs.map((d) => {
      const x = d.data();
      return {
        id: d.id,
        label: x.label,
        key_prefix: x.key_prefix,
        created_at: tsToIso(x.created_at),
        last_used_at: tsToIso(x.last_used_at),
        revoked_at: tsToIso(x.revoked_at),
      };
    }),
  });
});

consoleApi.post("/connections/:id/api-keys", async (req, res) => {
  const conn = await loadOwnedConnection(req, res);
  if (!conn) return;

  const { label } = (req.body ?? {}) as { label?: string };

  const k = generateApiKey();
  const ref = await apiKeysCol.add({
    ibkr_connection_id: conn.id,
    key_hash: k.hash,
    key_prefix: k.prefix,
    label: label ?? null,
    created_at: FieldValue.serverTimestamp() as never,
    last_used_at: null,
    revoked_at: null,
  });

  // The RAW key is shown ONCE here. It is not stored anywhere else.
  res.status(201).json({
    id: ref.id,
    label: label ?? null,
    key_prefix: k.prefix,
    raw_key: k.raw,
  });
});

consoleApi.delete("/api-keys/:keyId", async (req, res) => {
  const { account_id } = req.consoleUser!;
  const keyRef = apiKeysCol.doc(String(req.params.keyId));
  const keyDoc = await keyRef.get();
  if (!keyDoc.exists) {
    res.status(404).json({ error: "api key not found" });
    return;
  }
  const connId = keyDoc.get("ibkr_connection_id") as string;
  const conn = await connectionsCol.doc(connId).get();
  if (!conn.exists || conn.get("account_id") !== account_id) {
    res.status(404).json({ error: "api key not found" });
    return;
  }
  if (keyDoc.get("revoked_at") == null) {
    await keyRef.update({ revoked_at: FieldValue.serverTimestamp() });
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface OwnedConn {
  id: string;
  data: ConnectionDoc;
}

async function loadOwnedConnection(
  req: Request,
  res: Response
): Promise<OwnedConn | null> {
  const { account_id } = req.consoleUser!;
  const id = String(req.params.id);
  const doc = await connectionsCol.doc(id).get();
  if (!doc.exists || doc.get("account_id") !== account_id) {
    res.status(404).json({ error: "connection not found" });
    return null;
  }
  return { id, data: doc.data()! };
}

function publicConnection(id: string, c: ConnectionDoc) {
  return {
    id,
    label: c.label,
    mode: c.mode ?? "paper", // legacy docs without mode are paper
    ibkr_account_id: c.ibkr_account_id,
    credential_status: c.credential_status,
    credential_checked_at: tsToIso(c.credential_checked_at),
    created_at: tsToIso(c.created_at),
  };
}

// ---------------------------------------------------------------------------
// Shared body parser / validator for POST + PUT connection forms.
//
// `requireMode: true`  → mode is required (POST creates a new connection).
// `requireMode: false` → mode is optional (PUT rotates creds on an existing
//                        connection; we use the doc's stored mode).
//
// For live mode the activation code is required and must look like base32
// (we use the same alphabet check as lib/ibkr/totp.js → assertValidTotpSecret;
// rejecting malformed secrets here saves a Chromium spawn at runtime).
// ---------------------------------------------------------------------------

interface ParsedConnectionBody {
  label?: string | null;
  mode?: "paper" | "live";
  ibkr_username: string;
  ibkr_password: string;
  ibkr_totp_secret?: string;
}

function parseConnectionBody(
  body: unknown,
  { requireMode }: { requireMode: boolean }
): ParsedConnectionBody | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const mode = b.mode as "paper" | "live" | undefined;
  if (mode !== undefined && mode !== "paper" && mode !== "live") {
    return { error: "mode must be 'paper' or 'live'" };
  }
  if (requireMode && !mode) {
    return { error: "mode is required (paper or live)" };
  }

  const ibkr_username = typeof b.ibkr_username === "string" ? b.ibkr_username.trim() : "";
  const ibkr_password = typeof b.ibkr_password === "string" ? b.ibkr_password : "";
  if (!ibkr_username || !ibkr_password) {
    return { error: "ibkr_username and ibkr_password are required" };
  }

  const rawTotp = typeof b.ibkr_totp_secret === "string" ? b.ibkr_totp_secret : "";
  // Normalise the same way lib/ibkr/totp.js does so users can paste with
  // spaces / hyphens / lowercase letters and we still accept it.
  const totp = rawTotp.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  let ibkr_totp_secret: string | undefined;
  if (totp) {
    if (!/^[A-Z2-7]+$/.test(totp)) {
      return { error: "activation code must be base32 (letters A-Z and digits 2-7)" };
    }
    if (totp.length < 16) {
      return {
        error:
          "activation code looks too short (IBKR's base32 secret is normally ≥16 chars)",
      };
    }
    ibkr_totp_secret = totp;
  }

  if (mode === "live" && !ibkr_totp_secret) {
    return {
      error:
        "activation code is required for live mode (see /help/authenticator-app)",
    };
  }
  if (mode === "paper" && ibkr_totp_secret) {
    return {
      error:
        "paper accounts cannot have 2FA — drop the activation code",
    };
  }

  const label = typeof b.label === "string" && b.label.trim()
    ? b.label.trim()
    : null;

  return {
    label,
    mode,
    ibkr_username,
    ibkr_password,
    ibkr_totp_secret,
  };
}

function tsToIso(ts: unknown): string | null {
  if (!ts) return null;
  // Firestore Timestamp has toDate(); a plain Date also has toISOString.
  if (typeof (ts as { toDate?: () => Date }).toDate === "function") {
    return (ts as { toDate: () => Date }).toDate().toISOString();
  }
  if (ts instanceof Date) return ts.toISOString();
  return null;
}

// ---------------------------------------------------------------------------
// Error handler: keeps the process alive on Firestore / Secret Manager errors.
// Mounted LAST.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
consoleApi.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const e = err as { message?: string; code?: number; details?: string };
  // Surface useful detail without leaking credentials (none flow through here).
  const status = typeof e.code === "number" && e.code >= 400 && e.code <= 599 ? e.code : 500;
  console.error("console api error:", e.message ?? err, e.details ?? "");
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: e.message ?? "internal error",
    detail: e.details,
  });
});
