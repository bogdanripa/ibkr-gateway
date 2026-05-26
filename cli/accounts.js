#!/usr/bin/env node
// `node cli/accounts.js [list|set|unset|current] ...`
//
//   list                       — show all accounts on this session
//                                (marks the currently-selected one)
//   set <accountId>            — pin the working account; persists to
//                                ~/.ibkr-cli/session.json so subsequent
//                                runs of positions / place-order /
//                                orders use it.
//   unset                      — clear the current selection.
//   current                    — print the currently-selected accountId
//                                (or "(none)" if not set).

import { argv, exit } from 'node:process';
import { IbkrClient } from './lib/client.js';
import { loadState, saveState, sessionPath } from './lib/session-file.js';

const sub = argv[2] || 'list';

const state = await loadState();
if (!state) { console.error(`no session at ${sessionPath()} — run \`node cli/login.js\` first`); exit(2); }
const client = new IbkrClient({ state });
if (!client.isSignedIn()) { console.error('session has no cookies — re-run login'); exit(2); }

try {
  if (sub === 'list') {
    const list = await client.getAccounts();
    const current = client.getCurrentAccount();
    if (!list.length) { console.log('(no accounts)'); exit(0); }
    const w = Math.max(10, ...list.map((a) => (a.accountId || a.id || '').length));
    console.log(' ' + 'AccountId'.padEnd(w) + '  Title                       Opened       Currency  Type');
    console.log('-'.repeat(w + 70));
    for (const a of list) {
      const id = a.accountId || a.id || '';
      const marker = id === current ? '*' : ' ';
      const title = (a.accountTitle || a.displayName || '').slice(0, 26);
      // accountStatus is the open-date as a JS ms timestamp (or 0).
      const opened = a.accountStatus
        ? new Date(a.accountStatus).toISOString().slice(0, 10)
        : '—';
      const type = a.type || a.tradingType || '';
      console.log(`${marker} ${id.padEnd(w)}  ${title.padEnd(26)}  ${opened.padEnd(10)}   ${(a.currency || '').padEnd(8)} ${type}`);
    }
    if (current) console.log(`\n* = current. Change with: node cli/accounts.js set <id>`);
    else console.log(`\nno current account selected. Set with: node cli/accounts.js set <id>`);
    await saveState(client.getState());
    exit(0);
  }

  if (sub === 'set') {
    const id = argv[3];
    if (!id) { console.error('usage: accounts set <accountId>'); exit(2); }
    await client.setCurrentAccount(id);
    await saveState(client.getState());
    console.log(`current account = ${id}  (saved to ${sessionPath()})`);
    exit(0);
  }

  if (sub === 'unset') {
    client.unsetCurrentAccount();
    await saveState(client.getState());
    console.log('current account cleared');
    exit(0);
  }

  if (sub === 'current') {
    const c = client.getCurrentAccount();
    console.log(c || '(none)');
    exit(0);
  }
} catch (e) {
  console.error('✗ ' + (e.message || e));
  exit(1);
}

console.error(`unknown subcommand '${sub}'`);
console.error('usage: accounts list | set <id> | unset | current');
exit(2);
