// Default persistence for IbkrClient state — a JSON file at
// ~/.ibkr-cli/session.json (mode 0600). Used by the bundled CLIs; if
// you're embedding IbkrClient in your own app, use client.getState() /
// setState() with whatever storage you prefer.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const DIR = join(homedir(), '.ibkr-cli');
const FILE = join(DIR, 'session.json');

export function sessionPath() { return FILE; }

export async function loadState() {
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function saveState(state) {
  const payload = { ...state, updatedAt: new Date().toISOString() };
  await fs.mkdir(dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  await fs.rename(tmp, FILE);
}

export async function clearState() {
  try { await fs.unlink(FILE); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
