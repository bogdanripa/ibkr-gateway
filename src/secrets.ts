// GCP Secret Manager integration for IBKR credentials (§6.1).
//
// One secret per ibkr_connection. The secret VALUE is the JSON payload
// { username, password }. The Firestore document stores only a reference
// (the secret resource name) — never the credential itself.
//
// NEVER log credential values. The fetchCredential() function returns
// plaintext that must be dropped from memory as soon as the Gateway login
// completes (§7.1 step 4).

import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { config } from "./config.js";

const client = new SecretManagerServiceClient();

export type IbkrMode = "paper" | "live";

export interface IbkrCredential {
  username: string;
  password: string;
  /** "paper" | "live" — selects the IBKR /sso/Login mode toggle. */
  mode: IbkrMode;
  /**
   * IBKR "Authenticator App" activation code (base32 TOTP secret).
   * Required for `mode: "live"` so the gateway can re-auth unattended;
   * MUST be absent for paper (paper accounts have no 2FA).
   */
  totp_secret?: string;
}

const PARENT = () => `projects/${config.projectId}`;
const SECRET_NAME = (id: string) => `ibkr-conn-${id}`;
const SECRET_PATH = (id: string) => `${PARENT()}/secrets/${SECRET_NAME(id)}`;

/**
 * Create a fresh secret for a connection and write its first version.
 * Returns the resource name to store in ibkr_connections.ibkr_credential_ref.
 *
 * Throws if the secret already exists — callers should use
 * updateCredential() to rotate.
 */
export async function createCredential(
  connectionId: string,
  credential: IbkrCredential
): Promise<string> {
  const secretName = SECRET_NAME(connectionId);

  await client.createSecret({
    parent: PARENT(),
    secretId: secretName,
    secret: {
      replication: { automatic: {} },
      // Secret Manager label VALUES must match [\p{Ll}\p{Lo}\p{N}_-]{0,63}
      // — lowercase letters, digits, _, -. Firestore doc ids include
      // uppercase, so we don't put the connection id here; the secret
      // NAME already contains it.
      labels: { app: "ibkr-gateway" },
    },
  });

  await client.addSecretVersion({
    parent: SECRET_PATH(connectionId),
    payload: { data: Buffer.from(JSON.stringify(credential), "utf8") },
  });

  return SECRET_PATH(connectionId);
}

/**
 * Add a new version to an existing secret (credential rotation, §6.1).
 * Older versions are not destroyed automatically — Secret Manager keeps
 * the history. We always access "latest".
 */
export async function updateCredential(
  connectionId: string,
  credential: IbkrCredential
): Promise<void> {
  await client.addSecretVersion({
    parent: SECRET_PATH(connectionId),
    payload: { data: Buffer.from(JSON.stringify(credential), "utf8") },
  });
}

/**
 * Fetch the latest credential. Plaintext is in memory only for the
 * duration the caller holds it — callers MUST drop the reference as
 * soon as the Gateway login completes (§7.1).
 */
export async function fetchCredential(
  connectionId: string
): Promise<IbkrCredential> {
  const [resp] = await client.accessSecretVersion({
    name: `${SECRET_PATH(connectionId)}/versions/latest`,
  });
  const data = resp.payload?.data;
  if (!data) throw new Error("Secret payload empty");
  const json = Buffer.isBuffer(data)
    ? data.toString("utf8")
    : Buffer.from(data).toString("utf8");
  const parsed = JSON.parse(json) as Partial<IbkrCredential>;
  if (!parsed.username || !parsed.password) {
    throw new Error("Secret payload missing username/password");
  }
  // Legacy payloads created before the mode field existed get treated
  // as paper (the only safe default — they could not have had TOTP).
  const mode: IbkrMode = parsed.mode === "live" ? "live" : "paper";
  if (mode === "live" && !parsed.totp_secret) {
    throw new Error("Secret payload missing totp_secret for live mode");
  }
  return {
    username: parsed.username,
    password: parsed.password,
    mode,
    totp_secret: mode === "live" ? parsed.totp_secret : undefined,
  };
}

/**
 * Destroy the secret entirely. Used on offboarding (§6.1) — removing a
 * connection MUST destroy the Secret Manager secret, not just delete
 * the Firestore document.
 */
export async function destroyCredential(connectionId: string): Promise<void> {
  await client.deleteSecret({ name: SECRET_PATH(connectionId) });
}

/** Does a secret already exist for this connection? */
export async function credentialExists(connectionId: string): Promise<boolean> {
  try {
    await client.getSecret({ name: SECRET_PATH(connectionId) });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 5 /* NOT_FOUND */) return false;
    throw err;
  }
}
