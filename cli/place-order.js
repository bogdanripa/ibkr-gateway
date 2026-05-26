#!/usr/bin/env node
// `node cli/place-order.js --symbol AAPL --side BUY --qty 1 --type MKT [...]`

import { argv, exit, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { IbkrClient } from './lib/client.js';
import { loadState, saveState, sessionPath } from './lib/session-file.js';

const flag = (name) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return undefined;
  if (name === 'outside-rth' || name === 'yes') return true;
  return argv[i + 1];
};
const usage = () => {
  console.error('usage: node cli/place-order.js --symbol AAPL --side BUY --qty 1 --type MKT [--limit P] [--stop P] [--tif DAY|GTC|IOC|OPG] [--outside-rth] [--account ID] [--yes]');
  exit(2);
};

const opts = {
  conid: flag('conid') ? Number(flag('conid')) : undefined,
  symbol: flag('symbol'),
  side: flag('side'),
  quantity: flag('qty') ? Number(flag('qty')) : undefined,
  orderType: flag('type'),
  limitPrice: flag('limit') !== undefined ? Number(flag('limit')) : undefined,
  stopPrice: flag('stop') !== undefined ? Number(flag('stop')) : undefined,
  tif: flag('tif') || 'DAY',
  outsideRth: !!flag('outside-rth'),
  accountId: flag('account'),
};
const autoYes = !!flag('yes');
if (!opts.side || !opts.quantity || !opts.orderType || (!opts.symbol && !opts.conid)) usage();

const state = await loadState();
if (!state) { console.error(`no session at ${sessionPath()} — run \`node cli/login.js\` first`); exit(2); }
const client = new IbkrClient({ state });
if (!client.isSignedIn()) { console.error('session has no cookies — re-run login'); exit(2); }
if (state.isPendingApplicant) { console.error('⚠  pending-application account — orders unavailable'); exit(1); }

try {
  console.error('  · ensuring brokerage tier is up');
  const st = await client.ensureBrokerage();
  console.error(`  · iserver: authenticated=${st.authenticated} connected=${st.connected}`);
  await saveState(client.getState());
} catch (e) {
  console.error('✗ could not establish brokerage tier: ' + (e.message || e));
  console.error('  re-run `node cli/login.js` to refresh cookies');
  exit(1);
}

const onConfirm = async ({ message }) => {
  console.error('\nIBKR confirmation prompt:');
  for (const line of message.split('\n')) console.error('  ' + line);
  if (autoYes) { console.error('  → auto-confirming (--yes)'); return true; }
  if (!stdin.isTTY) { console.error('  → no TTY and no --yes; cancelling'); return false; }
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question('confirm [y/N]? ')).trim();
  rl.close();
  return /^y(es)?$/i.test(ans);
};

try {
  const result = await client.placeOrder({
    ...opts,
    onConfirm,
    onProgress: (m) => console.error('  · ' + m),
  });
  console.error('');
  console.error(`✓ order chain completed (${result.length} response row${result.length === 1 ? '' : 's'}):`);
  for (const r of result) console.error('   ' + JSON.stringify(r));
} catch (e) {
  console.error('✗ ' + (e.message || e));
  if (e.stage === 'no-account-selected') {
    console.error('  → use `node cli/accounts.js set <id>` or pass --account ID');
  }
  exit(1);
}
