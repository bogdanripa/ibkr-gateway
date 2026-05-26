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
import { Progress } from './lib/progress.js';
import { humanError } from './lib/errors.js';

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
    console.error('✗ ' + humanError(e));
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

  // Live mode requires the IBKR Authenticator-App secret so we can
  // generate the 6-digit code locally and complete 2FA unattended.
  // Paper accounts don't have 2FA. See:
  //   https://ibkr-gateway.bogdanripa.com/help/authenticator-app
  let totpSecret = null;
  let headed = false;
  if (mode === 'live') {
    console.log('');
    console.log('  Live accounts must have IBKR\'s "Authenticator App" 2FA enabled.');
    console.log('  Paste the activation code (base32 secret) IBKR showed you when');
    console.log('  you enrolled. Not the 6-digit code — the secret.');
    console.log('  Help: https://ibkr-gateway.bogdanripa.com/help/authenticator-app');
    totpSecret = (await askPassword('Activation code: ')).replace(/\s+/g, '');
    if (!totpSecret) throw new Error('activation code required for live mode');
  } else {
    headed = await yesNo('Open browser visibly (debugging only)?');
  }

  const p = new Progress();
  let result;
  try {
    result = await client.signIn({
      username, password, mode, headed, totpSecret,
      onProgress: (m) => p.step(m),
      onNeedCode: async ({ previousRejected }) => {
        p.step('IBKR is asking for an emailed verification code');
        if (previousRejected) {
          console.log('  Previous code was rejected by IBKR. Check your email for a fresh one.');
        } else {
          console.log('  Check your email for a 6-digit "Temporary Security Code" from IBKR.');
        }
        const code = (await ask('Verification code (blank to abort): ')).trim();
        return code || null;
      },
    });
  } catch (e) {
    p.fail('sign-in failed: ' + humanError(e));
    throw e;
  }
  await saveState(client.getState());
  p.succeed(`signed in as ${result.userName ?? username} (mode=${mode})`);
  if (result.brokerage.state !== 'ok') {
    console.log(`  brokerage: unavailable (${humanError({ message: result.brokerage.error })})`);
  }
  if (result.isPendingApplicant) {
    console.log('  ⚠ account is in PENDING-APPLICATION state — most data endpoints will be empty.');
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
    // /portfolio/{id}/ledger always emits a synthetic "BASE" row that
    // sums every real currency into the account's base currency. For a
    // single-currency account it duplicates that currency exactly, so
    // drop it. For multi-currency accounts keep it but relabel it as
    // "TOTAL" so users know what it is.
    const realCcys = data.cash.filter((r) => r.ccy !== 'BASE'
      && (Number(r.cash) || Number(r.netLiq)));
    const baseRow = data.cash.find((r) => r.ccy === 'BASE');
    const cashRows = realCcys.length > 1 && baseRow
      ? [...realCcys, { ...baseRow, ccy: 'TOTAL' }]
      : realCcys;
    printTable('Cash (ledger)', cashRows, CASH_COLS);
    if (cashRows.some((r) => r.ccy === 'TOTAL')) {
      console.log('  (TOTAL = all currencies summed in the account base currency.)');
    }
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

// Format the IBKR order-time string ("YYMMDDhhmmss") into ISO-ish.
function fmtOrderTime(s) {
  if (!s || typeof s !== 'string' || s.length < 12) return s || '—';
  const yy = '20' + s.slice(0, 2);
  return `${yy}-${s.slice(2, 4)}-${s.slice(4, 6)} ${s.slice(6, 8)}:${s.slice(8, 10)}:${s.slice(10, 12)} UTC`;
}

function printRecord(rows) {
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) {
    if (v == null || v === '' || v === '—') continue;
    console.log(`  ${k.padEnd(w)}  ${v}`);
  }
}

async function orderStatus(client) {
  const id = await ask('Order id: ');
  if (!id) return;
  await safe(async () => {
    const s = await client.getOrderStatus(id);
    const status = s.order_status || s.order_state || s.status || 'unknown';
    const note = ORDER_STATUS_NOTE[status];
    console.log(`\n── Order ${s.order_id || id} ──`);
    printRecord([
      ['Action',     s.order_description_with_contract || s.order_description || s.orderDesc || ''],
      ['Symbol',     [s.symbol, s.sec_type, s.listing_exchange].filter(Boolean).join(' · ')
                       + (s.conid ? `  (conid ${s.conid})` : '')],
      ['Side',       s.side === 'B' ? 'BUY' : s.side === 'S' ? 'SELL' : s.side],
      ['Quantity',   s.size_and_fills
                        ? `${s.size_and_fills} (filled / total)`
                        : (s.total_size != null
                           ? `${s.total_size}` + (s.cum_fill != null ? ` (filled ${s.cum_fill})` : '')
                           : '')],
      ['Order type', s.order_type || s.orderType],
      ['Limit',      s.limit_price != null ? s.limit_price : (s.price || '')],
      ['Stop',       s.stop_price != null ? s.stop_price : ''],
      ['TIF',        s.tif || s.time_in_force],
      ['Status',     `${status}${note ? `  — ${note}` : ''}`],
      ['Placed at',  fmtOrderTime(s.order_time || s.last_execution_time)],
      ['Account',    s.account || s.order_clearing_account || ''],
    ]);
  });
}

async function cancelOrder(client) {
  const id = await ask('Order id to cancel: ');
  if (!id) return;
  if (!(await yesNo(`Really cancel order ${id}?`))) return;
  await safe(async () => {
    const r = await client.cancelOrder({ orderId: id });
    const msg = r?.msg || r?.message || 'cancellation request submitted';
    console.log(`✓ ${msg}`);
    printRecord([
      ['Order ID',  r?.order_id ?? id],
      ['Account',   r?.account || ''],
    ]);
  });
}

async function placeOrder(client) {
  // The brokerage tier has to be up before we can run secdef/search.
  try { await client.ensureBrokerage(); }
  catch (e) { console.error('✗ ' + humanError(e)); return; }

  // Use the same pick flow as Quote so the user explicitly disambiguates
  // tickers like MSFT (NASDAQ vs TSE-CDR vs MEXI vs EBS) instead of us
  // silently picking the first STK match.
  const sec = await pickSecurity(client);
  if (!sec) return;
  // Enrich with currency / listing exchange so the review block is
  // unambiguous (best-effort).
  let info = {};
  try { info = await client.getSecurityInfo(sec.conid); } catch { /* ignore */ }
  const ccy = info.currency || sec.currency || '';
  const exch = info.listingExchange || '';
  const tickerLabel = sec.symbol + (exch ? ` (${exch}${ccy ? `, ${ccy}` : ''})` : '');

  const side = (await ask('Side [BUY/SELL]: ')).toUpperCase();
  if (!['BUY', 'SELL'].includes(side)) { console.error('invalid side'); return; }
  const quantity = Number(await ask('Quantity: '));
  if (!quantity || quantity <= 0) { console.error('invalid quantity'); return; }
  const orderType = (await ask('Order type [MKT/LMT/STP/STP_LIMIT] (default MKT): ')).toUpperCase() || 'MKT';
  let limitPrice, stopPrice;
  if (/^LMT|STP_LIMIT$/i.test(orderType)) {
    limitPrice = Number(await ask(`Limit price${ccy ? ` (${ccy})` : ''}: `));
    if (!limitPrice) { console.error('limit price required'); return; }
  }
  if (/^STP/i.test(orderType) && orderType !== 'STP_LIMIT') {
    stopPrice = Number(await ask(`Stop price${ccy ? ` (${ccy})` : ''}: `));
    if (!stopPrice) { console.error('stop price required'); return; }
  }
  const tif = (await ask('TIF [DAY/GTC/IOC/OPG] (default DAY): ')).toUpperCase() || 'DAY';
  const outsideRth = await yesNo('Allow execution outside regular trading hours?');

  console.log('');
  console.log('── Review ──');
  printRecord([
    ['Security',  `${tickerLabel}  ·  ${sec.description}  (conid ${sec.conid})`],
    ['Side',      side],
    ['Quantity',  String(quantity)],
    ['Type',      orderType + (limitPrice != null ? ` @ ${limitPrice}` : '') + (stopPrice != null ? ` stop ${stopPrice}` : '')],
    ['TIF',       tif],
    ['Outside RTH', outsideRth ? 'yes' : 'no'],
  ]);
  if (!(await yesNo('Place this order?'))) return;

  const p = new Progress();
  try {
    const result = await client.placeOrder({
      conid: sec.conid, side, quantity, orderType,
      limitPrice, stopPrice, tif, outsideRth,
      onConfirm: async ({ message }) => {
        p.clear();
        console.log('\nIBKR confirmation prompt:');
        for (const line of message.split('\n')) console.log('  ' + line);
        return yesNo('confirm');
      },
      onProgress: (m) => p.step(m),
    });
    const desc = orderSummary({ side, quantity, symbol: tickerLabel, orderType, limitPrice, stopPrice, tif, outsideRth });
    p.succeed('order placed');
    for (const r of result) printOrderResultRow(r, desc);
  } catch (e) {
    p.fail(humanError(e));
  }
}

const ORDER_STATUS_NOTE = {
  PreSubmitted: 'queued — IBKR will release it when market opens / conditions are met',
  Submitted:    'live in the order book',
  Filled:       'fully executed',
  Cancelled:    'cancelled (by you or IBKR)',
  Rejected:     'rejected — see the message above',
  Inactive:     'not transmitted (e.g. queued for next session)',
};

function orderSummary({ side, quantity, symbol, orderType, limitPrice, stopPrice, tif, outsideRth }) {
  let s = `${side} ${quantity} ${symbol} ${orderType}`;
  if (limitPrice != null) s += ` @ ${limitPrice}`;
  if (stopPrice != null) s += ` stop ${stopPrice}`;
  s += `, ${tif}`;
  if (outsideRth) s += ', outside-RTH';
  return s;
}

function printOrderResultRow(r, desc) {
  if (!r) { console.log('   (empty response)'); return; }
  const status = r.order_status || r.order_state || 'unknown';
  const id = r.order_id || r.orderId || r.local_order_id || '?';
  console.log(`   ${'Order ID'.padEnd(10)} ${id}`);
  if (desc)            console.log(`   ${'Action'.padEnd(10)} ${desc}`);
  console.log(`   ${'Status'.padEnd(10)} ${status}` + (ORDER_STATUS_NOTE[status] ? `  — ${ORDER_STATUS_NOTE[status]}` : ''));
  if (r.warning_message) console.log(`   ${'Warning'.padEnd(10)} ${r.warning_message}`);
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
  // Defend against null rows / null section entries — IBKR sometimes
  // returns sparse arrays for less-common security types.
  const shown = list.filter(Boolean).slice(0, 20);
  shown.forEach((r, i) => {
    const sectypes = [...new Set(
      (r.sections || []).filter(Boolean).map((s) => s && s.secType).filter(Boolean),
    )].join(',');
    const sym = String(r.symbol || '?').padEnd(8);
    const desc = String(r.description || '').padEnd(40);
    console.log(`  ${String(i + 1).padStart(2)}. ${sym} ${desc} ${sectypes}`);
  });
  if (list.length > shown.length) console.log(`  (… and ${list.length - shown.length} more)`);
  // Accept either a row number (1..N) or a ticker symbol from the
  // list above. Symbol match is case-insensitive and tried first
  // against the visible page, then the full list.
  const pick = (await ask('Pick number or ticker (Enter to cancel): ')).trim();
  if (!pick) return null;
  if (/^\d+$/.test(pick)) {
    const idx = Number(pick) - 1;
    if (idx < 0 || idx >= list.length) { console.log('invalid choice'); return null; }
    return list[idx];
  }
  const up = pick.toUpperCase();
  const exact = (rows) => rows.find((r) => (r?.symbol || '').toUpperCase() === up);
  const found = exact(shown) || exact(list);
  if (found) return found;
  // If the typed ticker is unambiguous but wasn't in the list (rare),
  // fall back to a fresh secdef/search.
  try {
    const fresh = await client.searchSecurity(pick);
    if (fresh.length === 1) return fresh[0];
    if (fresh.length > 1) {
      const stk = fresh.find((r) => r.sections.some((s) => s.secType === 'STK')) || fresh[0];
      return stk;
    }
  } catch { /* swallow */ }
  console.log(`no row with ticker '${pick}'`);
  return null;
}

async function showQuote(client) {
  await safe(async () => {
    await client.ensureBrokerage(); // marketdata needs the iserver tier up
    const sec = await pickSecurity(client);
    if (!sec) return;
    // /iserver/secdef/search doesn't return currency / listing exchange
    // — pull them from /iserver/secdef/info. Best-effort; falls back to
    // what we already have on `sec`.
    let info = {};
    try { info = await client.getSecurityInfo(sec.conid); } catch { /* ignore */ }
    const ccy = info.currency || sec.currency || '';
    const exch = info.listingExchange || '';
    const header = [sec.symbol, sec.description, exch && `[${exch}${ccy ? `, ${ccy}` : ''}]`]
      .filter(Boolean).join('  ');
    console.log(`\n── ${header}  (conid ${sec.conid}) ──`);

    const snap = await client.getQuote(sec.conid);
    const pad2 = (s, n) => String(s).padEnd(n);
    const px = (n) => fmtPrice(n) + (Number.isFinite(n) && ccy ? ` ${ccy}` : '');
    console.log(`  ${pad2('Last',  10)} ${px(snap.last)}` +
      (Number.isFinite(snap.changeAbs) || Number.isFinite(snap.changePct)
        ? `   (${fmtSigned(snap.changeAbs)}, ${fmtSigned(snap.changePct, '%')})`
        : ''));
    console.log(`  ${pad2('Bid',   10)} ${px(snap.bid)}${Number.isFinite(snap.bidSize) ? `   x${snap.bidSize}` : ''}`);
    console.log(`  ${pad2('Ask',   10)} ${px(snap.ask)}${Number.isFinite(snap.askSize) ? `   x${snap.askSize}` : ''}`);
    console.log(`  ${pad2('Day H/L', 10)} ${px(snap.dayHigh)} / ${px(snap.dayLow)}`);
    console.log(`  ${pad2('52w H/L', 10)} ${px(snap.week52High)} / ${px(snap.week52Low)}`);
    if (snap.volume != null) console.log(`  ${pad2('Volume', 10)} ${snap.volume}`);

    // Period-over-period changes (close-to-close).
    console.log(`\n  Change${ccy ? ` (${ccy})` : ''}`);
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
      { key: '0', label: 'Back' },
    ]);
    if (c === '1') await listAccounts(client);
    else if (c === '2') await setCurrentAccount(client);
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
