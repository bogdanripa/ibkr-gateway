// Persistent session = cookie jar + K + (optional) tstToken/deviceId.
// Stored at ~/.ibkr-cli/session.json.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const DIR = join(homedir(), '.ibkr-cli');
const FILE = join(DIR, 'session.json');

// Cookies the CPG considers session-significant (CookieManager.allowed,
// excluding the obviously transient ones). We persist every cookie the
// server sends us anyway, but use this for log/debug filtering only.
export const SESSION_COOKIES = [
  'XYZAB', 'XYZAB_AM.LOGIN', 'USERID', 'REGION',
  'JSESSIONID', 'web', 'RL', 'cp', 'portal', 'api',
];

export function emptySession() {
  return {
    cookies: {},   // name -> { value, path, domain, secure, httpOnly }
    kHex: null,    // BigInt of K in hex
    userId: null,
    userName: null,
    deviceId: null,
    tstToken: null,
    updatedAt: null,
  };
}

export async function loadSession() {
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return emptySession();
    throw e;
  }
}

export async function saveSession(session) {
  session.updatedAt = new Date().toISOString();
  await fs.mkdir(dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  await fs.rename(tmp, FILE);
}

export async function clearSession() {
  try { await fs.unlink(FILE); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

export function sessionPath() { return FILE; }
