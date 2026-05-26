// RFC 6238 TOTP (Time-based One-Time Password) — pure Node, no deps.
//
// IBKR's "Authenticator App" option enrolls a standard TOTP secret:
// algorithm=SHA1, digits=6, period=30s. Given the activation code
// (base32 secret) IBKR showed at enrollment, we can compute the same
// 6-digit code their server expects.

import { createHmac } from 'node:crypto';

// RFC 4648 base32 decoder. Tolerates whitespace, hyphens, lowercase,
// trailing '=' padding — i.e. handles every form IBKR / authenticator
// apps print the activation code in.
export function base32Decode(input) {
  if (!input) throw new Error('empty base32 input');
  const cleaned = String(input).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of cleaned) {
    const v = alphabet.indexOf(ch);
    if (v === -1) throw new Error(`invalid base32 character '${ch}'`);
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

// HOTP per RFC 4226 — TOTP is just HOTP with counter = floor(time / step).
function hotp(secret, counter, { digits = 6 } = {}) {
  const buf = Buffer.alloc(8);
  // 8-byte big-endian counter. JS numbers are 53 bits which is enough
  // until year ~~292277026596, so writeUInt32 over the low 32 is safe.
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset]     & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) <<  8) |
     (hmac[offset + 3] & 0xff)
  ) % (10 ** digits);
  return String(code).padStart(digits, '0');
}

// Generate the TOTP code for `secret` (base32 string) at time `now`
// (default: now). Returns { code, validUntilMs, validForMs } so the
// caller can decide whether to use a near-expiry code or wait one
// step for fresher one.
export function totp(secret, { now = Date.now(), step = 30, digits = 6 } = {}) {
  const key = base32Decode(secret);
  const counter = Math.floor(now / 1000 / step);
  const code = hotp(key, counter, { digits });
  const stepStartMs = counter * step * 1000;
  const validUntilMs = stepStartMs + step * 1000;
  return { code, validUntilMs, validForMs: validUntilMs - now };
}

// Wait until a "fresh" TOTP window (at least `minRemainingMs` left),
// then return its code. Use when the current window is about to expire
// and a network round-trip might race the rotation.
export async function freshTotp(secret, { minRemainingMs = 5000, ...opts } = {}) {
  const first = totp(secret, opts);
  if (first.validForMs >= minRemainingMs) return first;
  await new Promise((r) => setTimeout(r, first.validForMs + 50));
  return totp(secret, opts);
}

// Sanity-check the secret by trying to decode it. Throws with a clear
// message if it's not valid base32. Useful to validate at signin
// before we go open Chromium.
export function assertValidTotpSecret(secret) {
  try {
    const buf = base32Decode(secret);
    if (buf.length < 10) {
      throw new Error(`TOTP secret decodes to only ${buf.length} bytes; IBKR's secret is normally ≥16 bytes`);
    }
  } catch (e) {
    throw new Error(`invalid Authenticator App activation code: ${e.message}`);
  }
}
