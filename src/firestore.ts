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
  errors: "ibkr_errors",
  oauthClients: "ibkr_oauth_clients",
  oauthCodes: "ibkr_oauth_codes",
  oauthTokens: "ibkr_oauth_tokens",
  contactMessages: "ibkr_contact_messages",
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

/**
 * Production error log. Append-only; every entry is one observed
 * failure (auth refused, IBKR HTTP 5xx, tool dispatch crash, etc.).
 * Lives at the top level (not nested under a connection) so global
 * filters work; account_id / connection_id are denormalised for
 * filtering on the console side without joins.
 *
 * Indexed by account_id + ts desc (see firestore.indexes.json). The
 * expires_at field powers a Firestore TTL policy (configured
 * separately in the GCP console / via gcloud) so logs auto-delete
 * after a fortnight — we explicitly DO NOT want forever-retained
 * credentials-adjacent failure messages.
 */
export interface ErrorDoc {
  ts: Timestamp;
  source: "mcp" | "console-api" | "connection" | "unhandled";
  // Denormalised so listings can filter without an extra lookup.
  account_id: string | null;
  connection_id: string | null;
  api_key_id: string | null;
  code: string | null;       // e.g. "CREDENTIAL_REJECTED", "HTTP_500"
  message: string;
  stack: string | null;
  // Arbitrary contextual data (method/path/tool/args summary).
  // MUST NOT contain credential values — callers are responsible.
  context: Record<string, unknown> | null;
  expires_at: Timestamp;
}

// ---------- OAuth (MCP authorization server) ----------

/**
 * Dynamic client registration (RFC 7591). One row per MCP client
 * that has registered itself — e.g. Claude.ai, Cursor, a custom
 * harness. Clients are anonymous (no per-user binding) — the user
 * binding happens at /oauth/authorize when the human consents.
 */
export interface OAuthClientDoc {
  client_name: string;
  redirect_uris: string[];
  // Currently we only support PKCE-protected "public" clients
  // (no client_secret). MCP's primary use-case is desktop apps
  // that can't safely store secrets anyway.
  token_endpoint_auth_method: "none";
  created_at: Timestamp;
}

/**
 * Short-lived authorization codes (60s TTL). Issued from
 * /oauth/authorize after user consent, redeemed at /oauth/token
 * once for an access token. PKCE-bound: the code_challenge stored
 * here must match the code_verifier the client sends.
 */
export interface OAuthCodeDoc {
  client_id: string;
  redirect_uri: string;
  account_id: string;            // Firebase user's ibkr_accounts doc id
  connection_id: string;
  scope: "read" | "write";
  code_challenge: string;
  code_challenge_method: "S256";
  expires_at: Timestamp;
  used_at: Timestamp | null;
}

/**
 * Access tokens. Like API keys, we store sha256(token) plus an
 * 8-char prefix index for fast lookup; the raw token is given to
 * the client only at /oauth/token. Tokens are bound to a single
 * (connection, scope) pair — switching either requires re-authorize.
 */
export interface OAuthTokenDoc {
  client_id: string;
  account_id: string;
  connection_id: string;
  scope: "read" | "write";
  token_prefix: string;          // first 8 chars of raw token
  token_hash: string;            // base64 sha256
  created_at: Timestamp;
  expires_at: Timestamp;
  last_used_at: Timestamp | null;
  revoked_at: Timestamp | null;
}

/**
 * Public contact-form submissions. Written by POST /contact/submit
 * (no auth — anyone on the internet can submit). Read manually in
 * the Firebase console; no UI surface for them. Includes IP +
 * user-agent for follow-up forensics if a submission turns out to
 * be abuse.
 */
export interface ContactMessageDoc {
  ts: Timestamp;
  name: string;
  email: string;
  message: string;
  ip: string | null;
  user_agent: string | null;
}

// ---------- Typed collection accessors ----------
export const accountsCol = db.collection(COL.accounts) as FirebaseFirestore.CollectionReference<AccountDoc>;
export const connectionsCol = db.collection(COL.connections) as FirebaseFirestore.CollectionReference<ConnectionDoc>;
export const apiKeysCol = db.collection(COL.apiKeys) as FirebaseFirestore.CollectionReference<ApiKeyDoc>;
export const errorsCol = db.collection(COL.errors) as FirebaseFirestore.CollectionReference<ErrorDoc>;
export const oauthClientsCol = db.collection(COL.oauthClients) as FirebaseFirestore.CollectionReference<OAuthClientDoc>;
export const oauthCodesCol = db.collection(COL.oauthCodes) as FirebaseFirestore.CollectionReference<OAuthCodeDoc>;
export const oauthTokensCol = db.collection(COL.oauthTokens) as FirebaseFirestore.CollectionReference<OAuthTokenDoc>;
export const contactMessagesCol = db.collection(COL.contactMessages) as FirebaseFirestore.CollectionReference<ContactMessageDoc>;

/** Path to a connection's single session doc. */
export function sessionDocRef(connectionId: string): FirebaseFirestore.DocumentReference<SessionDoc> {
  return connectionsCol
    .doc(connectionId)
    .collection("session")
    .doc("state") as FirebaseFirestore.DocumentReference<SessionDoc>;
}
