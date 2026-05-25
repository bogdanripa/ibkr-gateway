// Console API. All routes require Firebase Auth (see auth.ts).
// Mounted at /console/api in src/index.ts.

import { Router, type Request, type Response } from "express";
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
  const { label, ibkr_username, ibkr_password } = (req.body ?? {}) as {
    label?: string;
    ibkr_username?: string;
    ibkr_password?: string;
  };

  if (!ibkr_username || !ibkr_password) {
    res.status(400).json({ error: "ibkr_username and ibkr_password are required" });
    return;
  }

  // 1. Create the Firestore document first (with a placeholder credential
  //    ref). We need its id to name the secret.
  const docRef = await connectionsCol.add({
    account_id,
    ibkr_account_id: null,
    label: label ?? null,
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

  const { ibkr_username, ibkr_password } = (req.body ?? {}) as {
    ibkr_username?: string;
    ibkr_password?: string;
  };
  if (!ibkr_username || !ibkr_password) {
    res.status(400).json({ error: "ibkr_username and ibkr_password are required" });
    return;
  }

  try {
    await updateCredential(conn.id, { username: ibkr_username, password: ibkr_password });
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
    ibkr_account_id: c.ibkr_account_id,
    credential_status: c.credential_status,
    credential_checked_at: tsToIso(c.credential_checked_at),
    created_at: tsToIso(c.created_at),
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
