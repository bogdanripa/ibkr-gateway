#!/usr/bin/env node
// `node cli/positions.js [--account ID]`  — list positions + cash.

import { argv, exit } from 'node:process';
import { IbkrClient } from './lib/client.js';
import { loadState, saveState, sessionPath } from './lib/session-file.js';

const flag = (n) => { const i = argv.indexOf('--' + n); return i < 0 ? undefined : argv[i + 1]; };

function pad(s, n, right = false) {
  s = String(s ?? '');
  if (s.length >= n) return s.slice(0, n);
  return right ? s.padStart(n) : s.padEnd(n);
}
function fmtNum(n, frac = 2) {
  if (n == null || Number.isNaN(Number(n))) return '';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac });
}
function printTable(title, rows, cols) {
  if (!rows.length) { console.log(`\n${title}: (none)`); return; }
  console.log(`\n${title}`);
  const header = cols.map((c) => pad(c.label, c.w, c.right)).join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of rows) console.log(cols.map((c) => pad(c.val(r), c.w, c.right)).join('  '));
}

const state = await loadState();
if (!state) { console.error(`no session at ${sessionPath()} — run \`node cli/login.js\` first`); exit(2); }
const client = new IbkrClient({ state });
if (!client.isSignedIn()) { console.error('session has no cookies — re-run login'); exit(2); }

try { await client.tickle(); } catch (e) {
  console.error(`tickle failed: ${e.message}\nrun \`node cli/login.js\` to refresh`); exit(1);
}

const explicitAccount = flag('account');
const accountIds = explicitAccount ? [explicitAccount] : (await client.getAccounts()).map((a) => a.accountId || a.id);

if (state.isPendingApplicant) {
  console.error('⚠  account is in PENDING-APPLICATION state — IBKR has no portfolio data yet.\n');
}

for (const id of accountIds) {
  const data = await client.getPositions(id);
  console.log(`\n══ Account ${data.accountId}`);
  if (data.brokerageAccess === false) {
    console.log('  (brokerageAccess: false — no portfolio data available.');
    console.log('   IBKR Application Status is still "In Progress" for this account.)');
    continue;
  }
  const stockCols = [
    { label: 'Symbol',  w: 10, val: (p) => p.contractDesc || p.ticker || '' },
    { label: 'Qty',     w: 12, right: true, val: (p) => fmtNum(p.position, 0) },
    { label: 'AvgCost', w: 12, right: true, val: (p) => fmtNum(p.avgCost) },
    { label: 'MktPx',   w: 12, right: true, val: (p) => fmtNum(p.mktPrice) },
    { label: 'MktVal',  w: 14, right: true, val: (p) => fmtNum(p.mktValue) },
    { label: 'P&L',     w: 12, right: true, val: (p) => fmtNum(p.unrealizedPnl) },
    { label: 'Ccy',     w:  4, val: (p) => p.currency || '' },
  ];
  printTable('Stocks', data.stocks, stockCols);
  const optCols = [
    { label: 'Contract', w: 30, val: (p) => p.contractDesc || p.ticker || '' },
    { label: 'Qty',      w:  8, right: true, val: (p) => fmtNum(p.position, 0) },
    { label: 'AvgCost',  w: 12, right: true, val: (p) => fmtNum(p.avgCost) },
    { label: 'MktPx',    w: 12, right: true, val: (p) => fmtNum(p.mktPrice) },
    { label: 'MktVal',   w: 14, right: true, val: (p) => fmtNum(p.mktValue) },
    { label: 'P&L',      w: 12, right: true, val: (p) => fmtNum(p.unrealizedPnl) },
    { label: 'Ccy',      w:  4, val: (p) => p.currency || '' },
  ];
  printTable('Options', data.options, optCols);
  for (const [k, rows] of Object.entries(data.other)) printTable(k, rows, stockCols);
  printTable('Cash (ledger)', data.cash.filter((r) => Number(r.cash) || Number(r.netLiq)), [
    { label: 'Ccy',           w:  6, val: (r) => r.ccy },
    { label: 'Cash',          w: 16, right: true, val: (r) => fmtNum(r.cash) },
    { label: 'NetLiq',        w: 16, right: true, val: (r) => fmtNum(r.netLiq) },
    { label: 'UnrPnL',        w: 14, right: true, val: (r) => fmtNum(r.unrealizedPnl) },
    { label: 'RealPnL',       w: 14, right: true, val: (r) => fmtNum(r.realizedPnl) },
    { label: 'ExcessLiq',     w: 16, right: true, val: (r) => fmtNum(r.excessLiq) },
  ]);
}

await saveState(client.getState());
