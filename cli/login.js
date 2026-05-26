#!/usr/bin/env node
// `node cli/login.js [--mode paper|live] [--headed]`
//
// Interactive IBKR login. Drives /sso/Login via Playwright, captures
// session, runs the post-login pipeline, persists state to
// ~/.ibkr-cli/session.json.
//
// Flags:
//   --mode paper|live     Live/Paper selector. Default: live.
//                         Also taken from IBKR_MODE env var, or the
//                         --paper shortcut (legacy).
//   --headed              show the browser (useful for IBKey 2FA push
//                         or to watch when something breaks).
//
// Env:
//   IBKR_USERNAME / IBKR_PASSWORD — skip the interactive prompts.

import { argv, exit, stdin, stdout, env } from 'node:process';
import { createInterface } from 'node:readline';
import { IbkrClient } from './lib/client.js';
import { loadState, saveState, sessionPath } from './lib/session-file.js';

const flag = (name) => {
  const i = argv.indexOf('--' + name);
  return i < 0 ? undefined : (argv[i + 1] ?? true);
};

const headed = argv.includes('--headed');
const mode = (flag('mode') && typeof flag('mode') === 'string')
  ? String(flag('mode')).toLowerCase()
  : (argv.includes('--paper') ? 'paper'
    : (env.IBKR_MODE ? env.IBKR_MODE.toLowerCase() : 'live'));
if (!['live', 'paper'].includes(mode)) {
  console.error(`invalid --mode '${mode}' (expected 'live' or 'paper')`); exit(2);
}

function ask(q) {
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a); }));
}
function askPassword(q) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      const rl = createInterface({ input: stdin, output: stdout });
      rl.question(q, (a) => { rl.close(); resolve(a); });
      return;
    }
    stdout.write(q);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      if (ch === '') { stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); reject(new Error('cancelled')); return; }
      if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); stdout.write('\n'); resolve(buf); return; }
      if (ch === '' || ch === '\b') { if (buf.length) { buf = buf.slice(0, -1); stdout.write('\b \b'); } return; }
      buf += ch; stdout.write('*');
    };
    stdin.on('data', onData);
  });
}

const username = (env.IBKR_USERNAME || '').trim() || (await ask('IBKR username: ')).trim();
if (!username) { console.error('username required'); exit(2); }
const password = env.IBKR_PASSWORD || (await askPassword('IBKR password: '));
if (!password) { console.error('password required'); exit(2); }

const client = new IbkrClient({ state: await loadState() });
try {
  const result = await client.signIn({
    username, password, mode, headed,
    onProgress: (m) => console.error(`  · ${m}`),
  });
  await saveState(client.getState());
  console.error(`✓ signed in (mode=${mode}, user=${result.userName ?? username}, id=${result.userId ?? '?'})`);
  console.error(`  saved to ${sessionPath()}`);
  console.error(`  brokerage: ${result.brokerage.state}` +
    (result.brokerage.authenticated != null
      ? ` (authenticated=${result.brokerage.authenticated} connected=${result.brokerage.connected})`
      : ''));
  if (result.isPendingApplicant) {
    console.error('');
    console.error('  ⚠  Account is in PENDING-APPLICATION state.');
    console.error('     Portfolio / order endpoints will return 500 until IBKR approves');
    console.error('     the application. Only account-meta endpoints work.');
  } else if (result.brokerage.state === 'unavailable') {
    console.error(`  note: brokerage handshake skipped (${result.brokerage.error}).`);
    console.error('        positions / cash work; order placement does not.');
  }
} catch (e) {
  console.error('✗ ' + (e.message || e));
  exit(1);
}
