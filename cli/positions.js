#!/usr/bin/env node
// `node cli/positions.js`  — list current positions and cash balances.
//
// Endpoints used (see docs/cpg-protocol.md §6):
//   GET /v1/api/portfolio/accounts
//   GET /v1/api/portfolio/{acct}/positions/{page}     (30 per page)
//   GET /v1/api/portfolio/{acct}/ledger
//
// Requires `node cli/auth.js` to have been run first.

import { exit } from 'node:process';
import { loadSession, saveSession, sessionPath } from './lib/session.js';
import { api } from './lib/api.js';
import { tickle } from './lib/auth.js';

function pad(s, n, right = false) {
  s = String(s ?? '');
  if (s.length >= n) return s.slice(0, n);
  return right ? s.padStart(n) : s.padEnd(n);
}

function fmtNum(n, frac = 2) {
  if (n == null || Number.isNaN(Number(n))) return '';
  const v = Number(n);
  return v.toLocaleString('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac });
}

function printTable(title, rows, cols) {
  if (!rows.length) {
    console.log(`\n${title}: (none)`);
    return;
  }
  console.log(`\n${title}`);
  const header = cols.map((c) => pad(c.label, c.w, c.right)).join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of rows) {
    console.log(cols.map((c) => pad(c.val(r), c.w, c.right)).join('  '));
  }
}

const session = await loadSession();
if (!session.cookies?.XYZAB && !session.cookies?.['XYZAB_AM.LOGIN']) {
  console.error(`no session at ${sessionPath()} — run \`node cli/auth.js\` first`);
  exit(2);
}

// One tickle to make sure the session is alive; if it dies we say so.
try { await tickle(session); } catch (e) {
  console.error(`tickle failed: ${e.message}\nrun \`node cli/auth.js\` to refresh cookies`);
  exit(1);
}

const accountsRes = await api.get(session, '/v1/api/portfolio/accounts');
if (accountsRes.status !== 200) {
  console.error(`/portfolio/accounts → HTTP ${accountsRes.status}: ${accountsRes.text.slice(0, 200)}`);
  exit(1);
}
const accounts = Array.isArray(accountsRes.data) ? accountsRes.data : [];
if (!accounts.length) {
  console.error('no accounts returned from /portfolio/accounts');
  exit(1);
}

for (const acct of accounts) {
  const id = acct.accountId || acct.id || acct.account;
  console.log(`\n══ Account ${id}  (${acct.accountTitle || acct.displayName || ''})`);

  // Positions, paginated 30/page.
  const positions = [];
  for (let page = 0; page < 50; page++) {
    const res = await api.get(session, `/v1/api/portfolio/${encodeURIComponent(id)}/positions/${page}`);
    if (res.status !== 200) {
      console.error(`positions page ${page} → HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      break;
    }
    const list = Array.isArray(res.data) ? res.data : [];
    if (!list.length) break;
    positions.push(...list);
    if (list.length < 30) break;
  }

  const byClass = positions.reduce((acc, p) => {
    const k = p.assetClass || 'OTHER';
    (acc[k] ||= []).push(p);
    return acc;
  }, {});

  const stockCols = [
    { label: 'Symbol',  w: 10, val: (p) => p.contractDesc || p.ticker || '' },
    { label: 'Qty',     w: 12, right: true, val: (p) => fmtNum(p.position, 0) },
    { label: 'AvgCost', w: 12, right: true, val: (p) => fmtNum(p.avgCost) },
    { label: 'MktPx',   w: 12, right: true, val: (p) => fmtNum(p.mktPrice) },
    { label: 'MktVal',  w: 14, right: true, val: (p) => fmtNum(p.mktValue) },
    { label: 'P&L',     w: 12, right: true, val: (p) => fmtNum(p.unrealizedPnl) },
    { label: 'Ccy',     w:  4, val: (p) => p.currency || '' },
  ];
  printTable('Stocks', byClass.STK || [], stockCols);

  const optCols = [
    { label: 'Contract', w: 30, val: (p) => p.contractDesc || p.ticker || '' },
    { label: 'Qty',      w:  8, right: true, val: (p) => fmtNum(p.position, 0) },
    { label: 'AvgCost',  w: 12, right: true, val: (p) => fmtNum(p.avgCost) },
    { label: 'MktPx',    w: 12, right: true, val: (p) => fmtNum(p.mktPrice) },
    { label: 'MktVal',   w: 14, right: true, val: (p) => fmtNum(p.mktValue) },
    { label: 'P&L',      w: 12, right: true, val: (p) => fmtNum(p.unrealizedPnl) },
    { label: 'Ccy',      w:  4, val: (p) => p.currency || '' },
  ];
  printTable('Options', byClass.OPT || [], optCols);

  const otherKinds = Object.keys(byClass).filter((k) => k !== 'STK' && k !== 'OPT');
  for (const k of otherKinds) {
    printTable(`${k}`, byClass[k], stockCols);
  }

  // Cash ledger.
  const ledgerRes = await api.get(session, `/v1/api/portfolio/${encodeURIComponent(id)}/ledger`);
  if (ledgerRes.status === 200 && ledgerRes.data && typeof ledgerRes.data === 'object') {
    const cashRows = Object.entries(ledgerRes.data)
      .filter(([k]) => k !== 'BASE' || true) // include BASE; user can read it
      .map(([ccy, l]) => ({
        ccy,
        cash: l.cashbalance,
        net: l.netliquidationvalue,
        unrPnl: l.unrealizedpnl,
        realPnl: l.realizedpnl,
        excLiq: l.excessliquidity,
      }))
      .filter((r) => Number(r.cash) || Number(r.net));
    printTable('Cash (ledger)', cashRows, [
      { label: 'Ccy',           w:  6, val: (r) => r.ccy },
      { label: 'Cash',          w: 16, right: true, val: (r) => fmtNum(r.cash) },
      { label: 'NetLiq',        w: 16, right: true, val: (r) => fmtNum(r.net) },
      { label: 'UnrPnL',        w: 14, right: true, val: (r) => fmtNum(r.unrPnl) },
      { label: 'RealPnL',       w: 14, right: true, val: (r) => fmtNum(r.realPnl) },
      { label: 'ExcessLiq',     w: 16, right: true, val: (r) => fmtNum(r.excLiq) },
    ]);
  } else {
    console.error(`ledger fetch → HTTP ${ledgerRes.status}`);
  }
}

await saveSession(session);
