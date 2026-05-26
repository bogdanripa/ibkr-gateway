// Firestore client + collection names + typed accessors.
// Collections are prefixed `ibkr_` to namespace within a shared GCP project (§6).

import { Firestore, type Timestamp } from "@google-cloud/firestore";
import { config } from "./config.js";

export const db = new Firestore({ projectId: config.projectId });

// ---------- Collection names (single source of truth) ----------
export const COL = {
  accounts: "ibkr_accounts",
  connections: "ibkr_connections",
  apiKeys: "ibkr_api_keys",
} as const;

// ---------- Document shapes (§6) ----------

export type AccountStatus = "active" | "suspended";

export interface AccountDoc {
  firebase_uid: string;
  email: string;
  display_name: string | null;
  created_at: Timestamp;
  status: AccountStatus;
}

export type CredentialStatus = "unknown" | "valid" | "rejected";

export type IbkrMode = "paper" | "live";

export interface ConnectionDoc {
  account_id: string;
  ibkr_account_id: string | null;
  label: string | null;
  /**
   * "paper" | "live". Determines which IBKR /sso/Login toggle the
   * gateway flips when re-authing. Immutable after connection
   * creation — to switch modes you delete the connection and create
   * a new one (the credentials, IBKR account, and audit history are
   * all different between live and paper).
   */
  mode: IbkrMode;
  created_at: Timestamp;
  ibkr_credential_ref: string;
  credential_status: CredentialStatus;
  credential_checked_at: Timestamp | null;
}

export interface ApiKeyDoc {
  ibkr_connection_id: string;
  key_hash: string;     // sha256(raw key), base64
  key_prefix: string;   // first 8 chars of raw key
  label: string | null;
  created_at: Timestamp;
  last_used_at: Timestamp | null;
  revoked_at: Timestamp | null;
}

/**
 * Per-connection IBKR session blob. Lives in the
 *   ibkr_connections/{id}/session/state
 * subcollection so the listing read on /console/api/connections
 * doesn't pull in the (~5–10 KB) session bytes on every page load.
 *
 * The `state` field is the exact shape returned by
 * `IbkrClient.getState()` in lib/ibkr/. Storing it as an opaque
 * JSON-compatible map (Firestore handles nested objects natively)
 * keeps Firestore schema decoupled from the client's evolution.
 */
export interface SessionDoc {
  state: Record<string, unknown>;
  updated_at: Timestamp;
  last_tickle_at: Timestamp | null;
  last_tickle_ok: boolean;
}

// ---------- Typed collection accessors ----------
export const accountsCol = db.collection(COL.accounts) as FirebaseFirestore.CollectionReference<AccountDoc>;
export const connectionsCol = db.collection(COL.connections) as FirebaseFirestore.CollectionReference<ConnectionDoc>;
export const apiKeysCol = db.collection(COL.apiKeys) as FirebaseFirestore.CollectionReference<ApiKeyDoc>;

/** Path to a connection's single session doc. */
export function sessionDocRef(connectionId: string): FirebaseFirestore.DocumentReference<SessionDoc> {
  return connectionsCol
    .doc(connectionId)
    .collection("session")
    .doc("state") as FirebaseFirestore.DocumentReference<SessionDoc>;
}
