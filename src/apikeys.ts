// API key generation + hashing.
// Format: "ibkr_<32 url-safe random chars>". 8-char prefix used for lookup;
// full key verified by constant-time hash compare. Raw key is shown ONCE
// at creation (§6).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

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
