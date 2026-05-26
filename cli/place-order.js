#!/usr/bin/env node
// `node cli/place-order.js`  — place a single equity order.
//
// Usage:
//   node cli/place-order.js --symbol AAPL --side BUY --qty 1 --type MKT
//   node cli/place-order.js --symbol AAPL --side BUY --qty 1 --type LMT --limit 150
//   node cli/place-order.js --conid 265598 --side SELL --qty 1 --type MKT
//
// Optional flags:
//   --account DUQ443672    explicit accountId; otherwise the first
//                          account from /portfolio/accounts is used.
//   --tif DAY              DAY | GTC | IOC | OPG          (default DAY)
//   --stop 145             stop price (for STP / STP_LIMIT)
//   --outside-rth          allow execution outside regular hours
//   --yes                  auto-confirm any IBKR warning prompts
//                          (otherwise the CLI shows each prompt and
//                          asks y/N).
//
// Requires `node cli/login.js` to have produced a brokerage-active
// session (`iserver: authenticated=true`). Pending-application paper
// accounts cannot place orders.

import { argv, exit, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { loadSession, saveSession, sessionPath } from './lib/session.js';
import { api, portalUrl } from './lib/api.js';
import { ensureBrokerage } from './lib/auth.js';
import { placeOrder } from './lib/orders.js';

function flag(name) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return undefined;
  // Value-less switches.
  if (name === 'outside-rth' || name === 'yes') return true;
  return argv[i + 1];
}

const params = {
  conid: flag('conid') ? Number(flag('conid')) : undefined,
  symbol: flag('symbol'),
  side: flag('side'),
  quantity: flag('qty') ? Number(flag('qty')) : undefined,
  orderType: flag('type'),
  limitPrice: flag('limit') !== undefined ? Number(flag('limit')) : undefined,
  stopPrice: flag('stop') !== undefined ? Number(flag('stop')) : undefined,
  tif: flag('tif') || 'DAY',
  outsideRth: !!flag('outside-rth'),
};
const explicitAccount = flag('account');
const autoYes = !!flag('yes');

if (!params.side || !params.quantity || !params.orderType || (!params.symbol && !params.conid)) {
  console.error('usage: node cli/place-order.js --symbol AAPL --side BUY --qty 1 --type MKT');
  console.error('       (see header comment for full flag list)');
  exit(2);
}

const session = await loadSession();
if (!session.cookies?.XYZAB && !session.cookies?.['XYZAB_AM.LOGIN']) {
  console.error(`no session at ${sessionPath()} — run \`node cli/login.js\` first`);
  exit(2);
}
if (session.isPendingApplicant) {
  console.error('⚠  account is in PENDING-APPLICATION state — order placement is not available.');
  exit(1);
}

// The iserver brokerage tier drops on idle; bring it back up if needed.
try {
  console.error('  · ensuring brokerage tier is up');
  const st = await ensureBrokerage(session);
  await saveSession(session);
  console.error(`  · iserver: authenticated=${st.authenticated} connected=${st.connected}`);
} catch (e) {
  console.error('✗ could not establish brokerage tier: ' + (e.message || e));
  console.error('  re-run `node cli/login.js` to refresh cookies');
  exit(1);
}

// Resolve accountId.
let accountId = explicitAccount;
if (!accountId) {
  const r = await api.get(session, portalUrl(session, 'portfolio/accounts'));
  if (r.status !== 200 || !Array.isArray(r.data) || !r.data.length) {
    console.error(`/portfolio/accounts → HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    exit(1);
  }
  accountId = r.data[0].accountId || r.data[0].id;
}
console.error(`account: ${accountId}`);

// Confirmation handler — by default we *show* each IBKR warning and
// only proceed on y/Y (or auto with --yes). This is a real-world
// trade — be explicit.
async function onConfirm({ id, message }) {
  console.error('\nIBKR confirmation prompt:');
  for (const line of message.split('\n')) console.error('  ' + line);
  if (autoYes) { console.error('  → auto-confirming (--yes)'); return true; }
  if (!stdin.isTTY) {
    console.error('  → no TTY and no --yes; treating as cancelled');
    return false;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question(`confirm [y/N]? `)).trim();
  rl.close();
  return /^y(es)?$/i.test(ans);
}

try {
  const result = await placeOrder(session, {
    accountId,
    ...params,
    onConfirm,
    onProgress: (m) => console.error('  · ' + m),
  });
  console.error('');
  console.error(`✓ order chain completed (${result.length} response row${result.length === 1 ? '' : 's'}):`);
  for (const r of result) console.error('   ' + JSON.stringify(r));
} catch (e) {
  console.error('✗ ' + (e.message || e));
  exit(1);
}
