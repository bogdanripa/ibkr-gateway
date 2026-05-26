#!/usr/bin/env node
// Interactive CLI for the IbkrClient module.
//
// Strict separation of concerns:
//   · lib/ibkr/   — the reusable IBKR Client Portal Web API client.
//                   No CLI dependencies. Imported as
//                   `import { IbkrClient } from '../lib/ibkr/index.js'`.
//                   Will be reused as-is by the web gateway.
//   · cli/ibkr.js (this file) + cli/lib/{prompt,session-file}.js
//                 — all UI and persistence. Talks to IbkrClient through
//                   its public methods only.
//
// Flow:
//   1. Load saved state (~/.ibkr-cli/session.json) if it exists.
//      If a session is found and looks valid → ask whether to reuse.
//   2. Otherwise prompt for mode (paper/live), username, password
//      and run signIn.
//   3. Drop into a numbered top-level menu (9 always = exit).
//      Sub-menus use 9 = back.

import { exit } from 'node:process';
import { IbkrClient } from '../lib/ibkr/index.js';
import { loadState, saveState, clearState, sessionPath } from './lib/session-file.js';
import { ask, askPassword, yesNo, menu, closePrompts } from './lib/prompt.js';

// ----- formatting helpers --------------------------------------------

function pad(s, n, right = false) {
  s = String(s ?? '');
  return s.length >= n ? s.slice(0, n) : (right ? s.padStart(n) : s.padEnd(n));
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

const STOCK_COLS = [
  { label: 'Symbol',  w: 10, val: (p) => p.contractDesc || p.ticker || '' },
  { label: 'Qty',     w: 10, right: true, val: (p) => fmtNum(p.position, 0) },
  { label: 'AvgCost', w: 12, right: true, val: (p) => fmtNum(p.avgCost) },
  { label: 'MktPx',   w: 12, right: true, val: (p) => fmtNum(p.mktPrice) },
  { label: 'MktVal',  w: 14, right: true, val: (p) => fmtNum(p.mktValue) },
  { label: 'P&L',     w: 12, right: true, val: (p) => fmtNum(p.unrealizedPnl) },
  { label: 'Ccy',     w:  4, val: (p) => p.currency || '' },
];
const OPT_COLS = [
  { label: 'Contract', w: 30, val: (p) => p.contractDesc || p.ticker || '' },
  ...STOCK_COLS.slice(1),
];
const CASH_COLS = [
  { label: 'Ccy',       w:  6, val: (r) => r.ccy },
  { label: 'Cash',      w: 16, right: true, val: (r) => fmtNum(r.cash) },
  { label: 'NetLiq',    w: 16, right: true, val: (r) => fmtNum(r.netLiq) },
  { label: 'UnrPnL',    w: 14, right: true, val: (r) => fmtNum(r.unrealizedPnl) },
  { label: 'RealPnL',   w: 14, right: true, val: (r) => fmtNum(r.realizedPnl) },
  { label: 'ExcessLiq', w: 16, right: true, val: (r) => fmtNum(r.excessLiq) },
];

// ----- safe wrapper: catch IbkrError + show ambiguous-account hint ----

async function safe(fn) {
  try { return await fn(); }
  catch (e) {
    console.error('✗ ' + (e?.message || e));
    if (e?.stage === 'no-account-selected') {
      console.error('  → use Accounts → Set current account');
    }
  }
}

// ----- sign-in --------------------------------------------------------

async function promptSignIn(client) {
  console.log('');
  console.log('── Sign in ──');
  let mode = (await ask("Mode [paper/live] (default 'live'): ")).toLowerCase() || 'live';
  if (!['paper', 'live'].includes(mode)) {
    console.error(`invalid mode '${mode}', defaulting to live`);
    mode = 'live';
  }
  const username = await ask('Username: ');
  if (!username) throw new Error('username required');
  const password = await askPassword('Password: ');
  if (!password) throw new Error('password required');

  const headed = await yesNo('Open browser visibly (needed for IBKey 2FA push)?');

  const result = await client.signIn({
    username, password, mode, headed,
    onProgress: (m) => process.stderr.write(`  · ${m}\n`),
  });
  await saveState(client.getState());
  console.log(`\n✓ signed in (mode=${mode}, user=${result.userName ?? username}, id=${result.userId ?? '?'})`);
  console.log(`  state saved to ${sessionPath()}`);
  if (result.brokerage.state === 'ok') {
    console.log(`  brokerage: authenticated=${result.brokerage.authenticated} connected=${result.brokerage.connected}`);
  } else {
    console.log(`  brokerage: unavailable (${result.brokerage.error})`);
  }
  if (result.isPendingApplicant) {
    console.log('  ⚠ account is in PENDING-APPLICATION state — portfolio/order endpoints will 500.');
  }
  if (result.accounts.length > 1) {
    console.log(`  ${result.accounts.length} accounts found; using ${client.getCurrentAccount() || '(none yet — pick one)'}`);
  }
}

// Returns a ready-to-use client (loaded session or fresh sign-in).
async function bootstrap() {
  const saved = await loadState();
  const client = new IbkrClient({ state: saved });

  if (saved && client.isSignedIn()) {
    const u = saved.userName || '?';
    const acct = saved.currentAccountId || '(none pinned)';
    console.log(`Existing session: user=${u}, account=${acct}, saved=${saved.updatedAt || '?'}`);
    const reuse = await yesNo('Reuse this session?', { defaultYes: true });
    if (reuse) {
      // Try a tickle to confirm cookies are still valid.
      try { await client.tickle(); }
      catch (e) {
        console.log(`(saved session no longer valid: ${e.message})`);
        await promptSignIn(client);
      }
      return client;
    }
    await client.signOut().catch(() => {});
    await clearState();
  }

  await promptSignIn(client);
  return client;
}

// ----- positions ------------------------------------------------------

async function showPortfolio(client) {
  await safe(async () => {
    const accountId = await client._resolveAccountId();
    const data = await client.getPositions(accountId);
    console.log(`\n══ Account ${data.accountId}`);
    printTable('Stocks', data.stocks, STOCK_COLS);
    printTable('Options', data.options, OPT_COLS);
    for (const [k, rows] of Object.entries(data.other)) printTable(k, rows, STOCK_COLS);
    printTable('Cash (ledger)',
      data.cash.filter((r) => Number(r.cash) || Number(r.netLiq)), CASH_COLS);
    if (data.errors.positions) console.log(`\n  · positions endpoint: ${data.errors.positions}`);
    if (data.errors.cash) console.log(`  · cash endpoint: ${data.errors.cash}`);
    if (!data.stocks.length && !data.options.length && !data.cash.length && !Object.keys(data.errors).length) {
      console.log('  (account has no positions and no cash entries.)');
    }
  });
}

// ----- orders sub-menu ------------------------------------------------

async function listOrders(client) {
  await safe(async () => {
    await client.ensureBrokerage();
    const orders = await client.getOrders();
    if (!orders.length) { console.log('(no orders)'); return; }
    console.log(
      pad('OrderId', 14) + '  ' + pad('Ticker', 8) + '  ' + pad('Side', 5) + '  ' +
      pad('Fills', 10, true) + '  ' + pad('Status', 18) + '  ' + 'Desc',
    );
    console.log('-'.repeat(120));
    for (const o of orders) {
      console.log(
        pad(o.orderId, 14) + '  ' + pad(o.ticker, 8) + '  ' + pad(o.side, 5) + '  ' +
        pad(o.sizeAndFills || `${o.filledQuantity ?? 0}/${o.totalSize ?? 0}`, 10, true) + '  ' +
        pad(o.status, 18) + '  ' + (o.orderDesc || ''),
      );
    }
  });
}

async function orderStatus(client) {
  const id = await ask('Order id: ');
  if (!id) return;
  await safe(async () => {
    const status = await client.getOrderStatus(id);
    console.log(JSON.stringify(status, null, 2));
  });
}

async function cancelOrder(client) {
  const id = await ask('Order id to cancel: ');
  if (!id) return;
  if (!(await yesNo(`Really cancel order ${id}?`))) return;
  await safe(async () => {
    const r = await client.cancelOrder({ orderId: id });
    console.log(JSON.stringify(r, null, 2));
  });
}

async function placeOrder(client) {
  const symbol = (await ask('Symbol (e.g. AAPL): ')).toUpperCase();
  if (!symbol) return;
  const side = (await ask('Side [BUY/SELL]: ')).toUpperCase();
  if (!['BUY', 'SELL'].includes(side)) { console.error('invalid side'); return; }
  const quantity = Number(await ask('Quantity: '));
  if (!quantity || quantity <= 0) { console.error('invalid quantity'); return; }
  const orderType = (await ask('Order type [MKT/LMT/STP/STP_LIMIT] (default MKT): ')).toUpperCase() || 'MKT';
  let limitPrice, stopPrice;
  if (/^LMT|STP_LIMIT$/i.test(orderType)) {
    limitPrice = Number(await ask('Limit price: '));
    if (!limitPrice) { console.error('limit price required'); return; }
  }
  if (/^STP/i.test(orderType) && orderType !== 'STP_LIMIT') {
    stopPrice = Number(await ask('Stop price: '));
    if (!stopPrice) { console.error('stop price required'); return; }
  }
  const tif = (await ask('TIF [DAY/GTC/IOC/OPG] (default DAY): ')).toUpperCase() || 'DAY';
  const outsideRth = await yesNo('Allow execution outside regular trading hours?');

  console.log(`\nReview: ${side} ${quantity} ${symbol} ${orderType}` +
    (limitPrice ? ` @ ${limitPrice}` : '') + (stopPrice ? ` stop=${stopPrice}` : '') +
    `  TIF=${tif}  outsideRTH=${outsideRth}`);
  if (!(await yesNo('Place this order?'))) return;

  await safe(async () => {
    await client.ensureBrokerage();
    const result = await client.placeOrder({
      symbol, side, quantity, orderType,
      limitPrice, stopPrice, tif, outsideRth,
      onConfirm: async ({ message }) => {
        console.log('\nIBKR confirmation prompt:');
        for (const line of message.split('\n')) console.log('  ' + line);
        return yesNo('confirm');
      },
      onProgress: (m) => process.stderr.write(`  · ${m}\n`),
    });
    console.log('');
    console.log(`✓ order chain completed (${result.length} response row${result.length === 1 ? '' : 's'}):`);
    for (const r of result) console.log('  ' + JSON.stringify(r));
  });
}

// ----- quote ----------------------------------------------------------

function fmtPrice(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtSigned(n, suffix = '') {
  if (n == null || Number.isNaN(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${suffix}`;
}

async function pickSecurity(client) {
  const q = (await ask('Ticker or company name: ')).trim();
  if (!q) return null;
  let list = [];
  try { list = await client.searchSecurity(q); }
  catch (e) { console.log(`✗ ${e.message}`); return null; }
  // Try by-name search as a fallback if the symbol search came up
  // empty (common when user typed a company name like "Apple").
  if (!list.length) {
    try { list = await client.searchSecurity(q, { name: true }); }
    catch { /* swallow */ }
  }
  if (!list.length) { console.log('(no matches)'); return null; }
  if (list.length === 1) return list[0];

  console.log('');
  const shown = list.slice(0, 20);
  shown.forEach((r, i) => {
    const sectypes = [...new Set((r.sections || []).map((s) => s.secType))].filter(Boolean).join(',');
    const sym = (r.symbol || '?').padEnd(8);
    const desc = (r.description || '').padEnd(40);
    console.log(`  ${String(i + 1).padStart(2)}. ${sym} ${desc} ${sectypes}`);
  });
  if (list.length > shown.length) console.log(`  (… and ${list.length - shown.length} more)`);
  const pick = await ask('Pick number (or Enter to cancel): ');
  if (!pick) return null;
  const idx = Number(pick) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= list.length) { console.log('invalid choice'); return null; }
  return list[idx];
}

async function showQuote(client) {
  await safe(async () => {
    await client.ensureBrokerage(); // marketdata needs the iserver tier up
    const sec = await pickSecurity(client);
    if (!sec) return;
    console.log(`\n── ${sec.symbol}  ${sec.description}  (conid ${sec.conid}) ──`);

    const snap = await client.getQuote(sec.conid);
    const pad2 = (s, n) => String(s).padEnd(n);
    console.log(`  ${pad2('Last',  10)} ${fmtPrice(snap.last)}` +
      (Number.isFinite(snap.changeAbs) || Number.isFinite(snap.changePct)
        ? `   (${fmtSigned(snap.changeAbs)}, ${fmtSigned(snap.changePct, '%')})`
        : ''));
    console.log(`  ${pad2('Bid',   10)} ${fmtPrice(snap.bid)}${Number.isFinite(snap.bidSize) ? `   x${snap.bidSize}` : ''}`);
    console.log(`  ${pad2('Ask',   10)} ${fmtPrice(snap.ask)}${Number.isFinite(snap.askSize) ? `   x${snap.askSize}` : ''}`);
    console.log(`  ${pad2('Day H/L', 10)} ${fmtPrice(snap.dayHigh)} / ${fmtPrice(snap.dayLow)}`);
    console.log(`  ${pad2('52w H/L', 10)} ${fmtPrice(snap.week52High)} / ${fmtPrice(snap.week52Low)}`);
    if (snap.volume != null) console.log(`  ${pad2('Volume', 10)} ${snap.volume}`);

    // Period-over-period changes.
    console.log(`\n  Change`);
    for (const [label, period, bar] of [
      ['1 day  ',  '1d',  '5min'],
      ['1 week ',  '1w',  '1h'],
      ['1 month',  '1m',  '1d'],
      ['1 year ',  '1y',  '1d'],
    ]) {
      try {
        const ch = await client.getChange(sec.conid, { period, bar });
        if (!ch) { console.log(`    ${label}  —`); continue; }
        console.log(`    ${label}  ${fmtPrice(ch.first)} → ${fmtPrice(ch.last)}   ${fmtSigned(ch.abs)}  ${fmtSigned(ch.pct, '%')}`);
      } catch (e) {
        console.log(`    ${label}  (${e.message})`);
      }
    }
  });
}

async function ordersMenu(client) {
  for (;;) {
    const c = await menu('Orders', [
      { key: '1', label: 'List open orders' },
      { key: '2', label: 'Place new order' },
      { key: '3', label: 'Check order status' },
      { key: '4', label: 'Cancel order' },
      { key: '0', label: 'Back' },
    ]);
    if (c === '1') await listOrders(client);
    else if (c === '2') await placeOrder(client);
    else if (c === '3') await orderStatus(client);
    else if (c === '4') await cancelOrder(client);
    else if (c === '0' || c === '') return;
    else console.log(`(unknown choice '${c}')`);
    await saveState(client.getState());
  }
}

// ----- accounts sub-menu ----------------------------------------------

async function listAccounts(client) {
  await safe(async () => {
    const list = await client.getAccounts();
    const current = client.getCurrentAccount();
    if (!list.length) { console.log('(no accounts)'); return; }
    const w = Math.max(10, ...list.map((a) => (a.accountId || a.id || '').length));
    console.log(' ' + 'AccountId'.padEnd(w) + '  Title                       Opened       Currency  Type');
    console.log('-'.repeat(w + 70));
    for (const a of list) {
      const id = a.accountId || a.id || '';
      const marker = id === current ? '*' : ' ';
      const title = (a.accountTitle || a.displayName || '').slice(0, 26);
      const opened = a.accountStatus ? new Date(a.accountStatus).toISOString().slice(0, 10) : '—';
      const type = a.type || a.tradingType || '';
      console.log(`${marker} ${id.padEnd(w)}  ${title.padEnd(26)}  ${opened.padEnd(10)}   ${(a.currency || '').padEnd(8)} ${type}`);
    }
    console.log(`\n* = current.`);
  });
}

async function setCurrentAccount(client) {
  const list = await client.getAccounts().catch(() => []);
  if (list.length < 2) { console.log('(only one account on this session — nothing to switch to)'); return; }
  for (const a of list) console.log(`  ${a.accountId || a.id}  ${a.accountTitle || ''}`);
  const id = await ask('Account id to set as current: ');
  if (!id) return;
  await safe(async () => {
    await client.setCurrentAccount(id);
    console.log(`current account = ${id}`);
  });
}

async function accountsMenu(client) {
  for (;;) {
    const current = client.getCurrentAccount() || '(none)';
    const c = await menu(`Accounts (current=${current})`, [
      { key: '1', label: 'List accounts' },
      { key: '2', label: 'Set current account' },
      { key: '3', label: 'Unset current account' },
      { key: '0', label: 'Back' },
    ]);
    if (c === '1') await listAccounts(client);
    else if (c === '2') await setCurrentAccount(client);
    else if (c === '3') { client.unsetCurrentAccount(); console.log('cleared'); }
    else if (c === '0' || c === '') return;
    else console.log(`(unknown choice '${c}')`);
    await saveState(client.getState());
  }
}

// ----- top level ------------------------------------------------------

async function mainMenu(client) {
  for (;;) {
    const title = `Main (user=${client.getState().userName || '?'}, account=${client.getCurrentAccount() || '(none)'})`;
    const c = await menu(title, [
      { key: '1', label: 'Portfolio' },
      { key: '2', label: 'Orders' },
      { key: '3', label: 'Accounts' },
      { key: '4', label: 'Quote' },
      { key: '5', label: 'Sign out (forget saved session)' },
      { key: '0', label: 'Exit' },
    ]);
    if (c === '1') await showPortfolio(client);
    else if (c === '2') await ordersMenu(client);
    else if (c === '3') await accountsMenu(client);
    else if (c === '4') await showQuote(client);
    else if (c === '5') {
      await client.signOut().catch(() => {});
      await clearState();
      console.log('signed out');
      return;
    }
    else if (c === '0' || c === '') return;
    else console.log(`(unknown choice '${c}')`);
    await saveState(client.getState());
  }
}

// ----- entry ----------------------------------------------------------

try {
  const client = await bootstrap();
  await mainMenu(client);
} catch (e) {
  console.error('✗ ' + (e?.message || e));
  closePrompts();
  exit(1);
}
closePrompts();
exit(0);
