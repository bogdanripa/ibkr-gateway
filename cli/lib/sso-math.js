// SHA-1 helpers ported from ibgroup.security.auth.client.lib.SsoCombined.
// See docs/cpg-protocol.md §4 for the exact byte-encoding rules.

import { createHash } from 'node:crypto';

function sha1Hex(input) {
  return createHash('sha1').update(input).digest('hex');
}

// SsoCombined.calcSHA1Hex packs the hex string into bytes (1 byte = 2 hex
// chars), pads an odd-length string with a leading '0', and then SHA-1s
// those bytes.
function sha1OfHexString(hex) {
  if (hex.length % 2 !== 0) hex = '0' + hex;
  return sha1Hex(Buffer.from(hex, 'hex'));
}

// SsoCombined.compute_sk(seed, verifier) — returns lowercase hex.
export function computeSk(challengeHex, kHex) {
  return sha1OfHexString(challengeHex + kHex);
}

// TstTokenUtils.getBytes("…") — codepoint → hex, concatenated.
function utf8CodepointsToHex(str) {
  let out = '';
  for (const ch of str) {
    out += ch.codePointAt(0).toString(16);
  }
  return out;
}

function trimLeading00(hex) {
  while (hex.length > 1 && hex.startsWith('00')) hex = hex.slice(2);
  return hex;
}

// TstTokenUtils.generateTSTK(deviceId, K)
export function generateTstToken(deviceId, kHex) {
  const tag = trimLeading00(utf8CodepointsToHex(deviceId + 'TST'));
  return sha1OfHexString(tag + trimLeading00(kHex));
}

// Device.genRandom — 8 hex chars from 100_000_000 + rand(999_999_999),
// formatted as %08x. Note: the Java code uses Random.nextInt(999_999_999)
// which can overflow to 9 hex chars; the format mask keeps it at 8 by
// truncating with %08x. We mirror the truncation.
export function genDeviceRandom() {
  const n = 100_000_000 + Math.floor(Math.random() * 999_999_999);
  return n.toString(16).padStart(8, '0').slice(-8);
}

// TstTokenUtils.getMacAddress — formats as `AA-BB-CC-DD-EE-FF`.
export function macToTstFormat(macColons) {
  return macColons.toUpperCase().replace(/:/g, '-');
}
