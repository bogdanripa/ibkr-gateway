// API key generation + hashing + lookup.
// Format: "ibkr_<32 url-safe random chars>". 8-char prefix used for lookup;
// full key verified by constant-time hash compare. Raw key is shown ONCE
// at creation (§6).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { FieldValue } from "@google-cloud/firestore";
import { apiKeysCol } from "./firestore.js";

const KEY_BODY_BYTES = 24;       // 24 bytes → 32 base64url chars
const PREFIX_LEN = 8;
const PREFIX_INDEX_START = "ibkr_".length;

export interface NewApiKey {
  raw: string;       // shown to user once
  prefix: string;    // stored in Firestore for lookup
  hash: string;      // stored in Firestore for verification
}

export function generateApiKey(): NewApiKey {
  const body = randomBytes(KEY_BODY_BYTES).toString("base64url");
  const raw = `ibkr_${body}`;
  return {
    raw,
    prefix: raw.slice(PREFIX_INDEX_START, PREFIX_INDEX_START + PREFIX_LEN),
    hash: hashKey(raw),
  };
}

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("base64");
}

export function prefixOf(raw: string): string {
  if (!raw.startsWith("ibkr_")) return "";
  return raw.slice(PREFIX_INDEX_START, PREFIX_INDEX_START + PREFIX_LEN);
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Resolve a raw bearer key to its connection id.
 *
 * Lookup is two-step (prefix index → constant-time hash compare across
 * matches) so an attacker can't infer key existence from response timing.
 * The 8-char prefix index makes this a single Firestore .where() round
 * trip in the common case; collisions are vanishingly rare (1 in 2^48
 * across all customers).
 *
 * Returns null for: malformed key, no matching prefix, no constant-time
 * hash match, or a revoked key (revoked_at != null).
 *
 * Side effect on success: bumps the matching api-key's last_used_at
 * timestamp (best-effort, never blocks the caller).
 */
export interface ResolvedApiKey {
  id: string;                 // ibkr_api_keys doc id
  ibkr_connection_id: string;
  label: string | null;
}

export async function findConnectionByApiKey(raw: string): Promise<ResolvedApiKey | null> {
  if (!raw || !raw.startsWith("ibkr_")) return null;
  const prefix = prefixOf(raw);
  if (!prefix) return null;

  const snap = await apiKeysCol.where("key_prefix", "==", prefix).get();
  if (snap.empty) return null;

  const candidateHash = hashKey(raw);
  let match: { id: string; ibkr_connection_id: string; label: string | null } | null = null;
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.revoked_at) continue;
    if (constantTimeEquals(d.key_hash, candidateHash)) {
      match = {
        id: doc.id,
        ibkr_connection_id: d.ibkr_connection_id,
        label: d.label,
      };
      break;
    }
  }
  if (!match) return null;

  // Touch last_used_at — fire-and-forget.
  apiKeysCol
    .doc(match.id)
    .update({ last_used_at: FieldValue.serverTimestamp() })
    .catch(() => undefined);

  return match;
}
