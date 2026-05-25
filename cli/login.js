#!/usr/bin/env node
// `node cli/login.js [--headed]`  — interactive IBKR login via Playwright.
//
// Why a real browser: see docs/cpg-protocol.md §3.1 and cli/lib/login.js.
//
// Prompts for username + password (password masked), drives the IBKR
// /sso/Login page in headless Chromium, captures cookies, then runs the
// post-login SSODH pipeline and persists to ~/.ibkr-cli/session.json.
//
// Flags:
//   --headed    show the browser (useful when IBKR rolls a new form
//               selector and you want to see what's happening).
//   --paper     flip the Live/Paper toggle to Paper before submitting.
//               Required for paper-only usernames (e.g. "*paper") —
//               leaving it on Live triggers IBKR's 2FA-looking error
//               screens. Also enabled via IBKR_PAPER=1.
//
// Reminder from this project's SPEC §2: the username you log in with
// MUST be 2FA-free (an IBKR secondary username). 2FA can't be answered
// headlessly.

import { argv, exit, stdin, stdout } from 'node:process';
import { createInterface, Interface } from 'node:readline';
import { loadSession, saveSession, sessionPath } from './lib/session.js';
import { loginWithBrowser } from './lib/login.js';
import { establishSession } from './lib/auth.js';

const headed = argv.includes('--headed');
const paper = argv.includes('--paper') || /^(1|true|yes)$/i.test(process.env.IBKR_PAPER || '');

function ask(question) {
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

// Masked password prompt: write the question, switch stdin to raw mode
// so we get keystrokes one-at-a-time, and echo '*' for each char.
function askPassword(question) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      // No TTY (CI / piped input) — fall back to readline, unmasked.
      const rl = createInterface({ input: stdin, output: stdout });
      rl.question(question, (a) => { rl.close(); resolve(a); });
      return;
    }
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      if (ch === '') { // Ctrl-C
        stdin.setRawMode(false); stdin.pause(); stdout.write('\n');
        reject(new Error('cancelled')); return;
      }
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(false); stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(buf); return;
      }
      if (ch === '' || ch === '\b') {
        if (buf.length) { buf = buf.slice(0, -1); stdout.write('\b \b'); }
        return;
      }
      buf += ch;
      stdout.write('*');
    };
    stdin.on('data', onData);
  });
}

const username = (process.env.IBKR_USERNAME || '').trim() || (await ask('IBKR username: ')).trim();
if (!username) { console.error('username required'); exit(2); }
const password = process.env.IBKR_PASSWORD || (await askPassword('IBKR password: '));
if (!password) { console.error('password required'); exit(2); }

const session = await loadSession();

try {
  const { cookies, apiBase, portalPrefix, finalUrl } = await loginWithBrowser({
    username, password, paper, headed,
    onProgress: (m) => console.error(`  · ${m}`),
  });
  // Merge — browser cookies win for any name collision.
  session.cookies = { ...session.cookies, ...cookies };
  session.apiBase = apiBase;
  session.portalPrefix = portalPrefix;
  console.error(`  · landed at ${finalUrl}`);
  await saveSession(session);
  console.error('→ running post-login pipeline…');
  const status = await establishSession(session);
  console.error(`✓ authenticated  (user=${session.userName ?? username} id=${session.userId ?? '?'})`);
  console.error(`  saved to ${sessionPath()}`);
  console.error(
    `  iserver: authenticated=${status.authenticated} competing=${status.competing} connected=${status.connected}` +
    (status.brokerage ? `  [brokerage: ${status.brokerage}]` : '')
  );
  if (session.isPendingApplicant) {
    console.error('');
    console.error('  ⚠  This account is in PENDING-APPLICATION state.');
    console.error('     IBKR has not yet approved/funded the account, so:');
    console.error('       · /portfolio/{id}/positions, /ledger, /summary return HTTP 500');
    console.error('       · brokerage SSODH handshake fails (no brokerage tier yet)');
    console.error('       · order placement is unavailable');
    console.error('     Only account-meta endpoints work until the application is approved.');
    console.error('     (Check status at https://www.interactivebrokers.com/portal/ → Application Status)');
  } else if (status.brokerage === 'unavailable') {
    console.error(`  note: brokerage handshake skipped (${status.brokerageError}).`);
    console.error('        portfolio / positions / cash endpoints still work; order placement does not.');
  }
} catch (e) {
  console.error('✗ ' + (e.message || e));
  console.error('  tip: pass --headed to watch the browser; or override selectors via IBKR_LOGIN_USER_SEL etc.');
  exit(1);
}
