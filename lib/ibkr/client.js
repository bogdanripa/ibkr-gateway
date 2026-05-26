// IbkrClient — a single class wrapping every interaction with the
// IBKR Client Portal Web API that we've reverse-engineered from the
// Java Client Portal Gateway.
//
//   import { IbkrClient } from './lib/client.js';
//   const c = new IbkrClient({ state: loadSavedState() });
//   await c.signIn({ username, password, mode: 'paper' });
//   await c.getPositions();        // implicit account (single or current)
//   // or:  await c.setCurrentAccount('U1234567'); await c.getPositions();
//   await c.placeOrder({ symbol: 'AAPL', side: 'BUY', quantity: 1, orderType: 'MKT' });
//   saveSavedState(c.getState());
//
// State (cookies, K, host pinning, user info) lives on the instance.
// The caller decides how to persist it (file, DB, env, etc.) via
// getState() / setState() or the constructor `state` argument.

import { request } from 'undici';
import { computeSk, genDeviceRandom, generateTstToken } from './sso-math.js';
import { loginWithBrowser } from './browser-login.js';

const DEFAULT_BASE = 'https://api.ibkr.com';
const DEFAULT_PORTAL_PREFIX = '/v1/api';
const USER_AGENT = 'ClientPortalGW/1';

function emptyState() {
  return {
    cookies: {},          // name → { value, path, domain, secure, httpOnly }
    kHex: null,           // shared secret K, hex string
    userId: null,
    userName: null,
    paperUserName: null,
    isPendingApplicant: null,
    apiBase: null,        // e.g. "https://ndcdyn.interactivebrokers.com"
    portalPrefix: null,   // e.g. "/portal.proxy/v1/portal" or "/v1/api"
    deviceId: null,
    tstToken: null,
    // Multi-account: an IBKR user may have several sub-accounts
    // (linked accounts, family accounts, paper + live, etc.). The
    // *current* one is the implicit target for getPositions/placeOrder/
    // etc. when none is passed. Resolved automatically if only one
    // account exists; otherwise must be set via setCurrentAccount().
    currentAccountId: null,
    // Cached account list from the last getAccounts() call — purely
    // to make setCurrentAccount() validation work offline and to power
    // the "ambiguous account" error message. Refreshed by getAccounts().
    accountsCache: null,
    accountsCacheAt: null,
    updatedAt: null,
  };
}

class IbkrError extends Error {
  constructor(message, { stage, status, body } = {}) {
    super(message);
    this.stage = stage; this.status = status; this.body = body;
  }
}

const SLEEP_MS = (ms) => new Promise((r) => setTimeout(r, ms));

// -- Cookie jar helpers (matches Java CookieManager scoping) -----

function parseSetCookie(line) {
  const parts = line.split(';').map((s) => s.trim());
  const [first, ...attrs] = parts;
  const eq = first.indexOf('=');
  if (eq < 0) return null;
  const name = first.slice(0, eq);
  const value = first.slice(eq + 1);
  const cookie = { value, path: '/', secure: false, httpOnly: false };
  for (const a of attrs) {
    const [k, v = ''] = a.split('=');
    const key = k.toLowerCase();
    if (key === 'path') cookie.path = v || '/';
    else if (key === 'domain') cookie.domain = v;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'expires') cookie.expires = v;
    else if (key === 'max-age') cookie.maxAge = Number(v);
  }
  return { name, cookie };
}

// =====================================================================

export class IbkrClient {
  constructor({ state = null, debug = false } = {}) {
    this.state = state ? { ...emptyState(), ...state } : emptyState();
    this.debug = debug;
  }

  // ---------- state plumbing ----------
  getState() { return JSON.parse(JSON.stringify(this.state)); }
  setState(state) { this.state = { ...emptyState(), ...state }; }

  // Convenience: did we ever successfully sign in (or get cookies)?
  isSignedIn() {
    return !!(this.state.cookies?.XYZAB || this.state.cookies?.['XYZAB_AM.LOGIN']);
  }

  // ---------- low-level HTTP ----------
  _portalUrl(rel) {
    const base = this.state.apiBase || DEFAULT_BASE;
    const prefix = this.state.portalPrefix || DEFAULT_PORTAL_PREFIX;
    return base + prefix + (rel.startsWith('/') ? rel : '/' + rel);
  }
  _hostUrl(rel) {
    const base = this.state.apiBase || DEFAULT_BASE;
    return base + (rel.startsWith('/') ? rel : '/' + rel);
  }
  _cookieHeader(urlPath) {
    const out = [];
    for (const [name, c] of Object.entries(this.state.cookies)) {
      const p = c.path || '/';
      if (!urlPath.startsWith(p) && p !== '/') continue;
      out.push(`${name}=${c.value}`);
    }
    return out.join('; ');
  }
  _captureSetCookies(headers) {
    const raw = headers['set-cookie'];
    if (!raw) return;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const line of list) {
      const c = parseSetCookie(line);
      if (!c || !c.cookie.value) continue;
      this.state.cookies[c.name] = c.cookie;
    }
  }

  async _http(method, url, { body, contentType, headers = {} } = {}) {
    const u = url.startsWith('http')
      ? new URL(url)
      : new URL((this.state.apiBase || DEFAULT_BASE) + url);
    const cookies = this._cookieHeader(u.pathname);
    const reqHeaders = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      ...headers,
    };
    if (cookies) reqHeaders.Cookie = cookies;
    if (body && contentType) reqHeaders['Content-Type'] = contentType;
    if (this.debug) console.error(`[ibkr] ${method} ${u.href}`);
    const res = await request(u, { method, headers: reqHeaders, body });
    this._captureSetCookies(res.headers);
    const ct = res.headers['content-type'] || '';
    const text = await res.body.text();
    let data = text;
    if (ct.includes('application/json')) {
      try { data = JSON.parse(text); } catch { /* keep text */ }
    }
    return { status: res.statusCode, headers: res.headers, data, text };
  }
  async _get(url, opts) { return this._http('GET', url, opts); }
  async _post(url, json, opts = {}) {
    return this._http('POST', url, {
      ...opts,
      body: JSON.stringify(json ?? {}),
      contentType: 'application/json',
    });
  }
  _expect200(stage, res) {
    if (res.status !== 200) {
      throw new IbkrError(
        `${stage} → HTTP ${res.status}: ${typeof res.data === 'string' ? res.text.slice(0, 200) : JSON.stringify(res.data).slice(0, 200)}`,
        { stage, status: res.status, body: res.data },
      );
    }
    return res.data;
  }

  // ---------- sign-in ----------

  // Drive the IBKR /sso/Login page via Playwright, capture cookies +
  // host, then run the post-login pipeline.
  //
  // mode: 'live' (default) | 'paper'
  // headed: open visible Chromium (useful for 2FA / debugging)
  // onProgress: (msg: string) => void
  async signIn({ username, password, mode = 'live', headed = false, onProgress = () => {}, debugDir } = {}) {
    if (!username || !password) throw new IbkrError('signIn: username and password required');
    if (!/^(live|paper)$/i.test(mode)) throw new IbkrError(`signIn: mode must be 'live' or 'paper', got ${mode}`);

    const paper = mode.toLowerCase() === 'paper';
    const { cookies, apiBase, portalPrefix, finalUrl } = await loginWithBrowser({
      username, password, paper, headed, onProgress, debugDir,
    });
    // Merge — browser cookies win on conflict.
    this.state.cookies = { ...this.state.cookies, ...cookies };
    this.state.apiBase = apiBase;
    this.state.portalPrefix = portalPrefix;
    onProgress(`landed at ${finalUrl}`);

    // Run the post-login pipeline.
    onProgress('running post-login pipeline');
    await this._validateSso();
    let brokerage = { state: 'ok' };
    try {
      await this._fetchK();
      await this._publishTstToken();
      const st = await this._brokerageAuthenticate();
      brokerage = { state: 'ok', ...st };
    } catch (e) {
      brokerage = { state: 'unavailable', error: e.message };
    }

    // Refresh account list + auto-pin a current account if there's
    // exactly one (single-account users never have to think about it).
    // Don't override an existing currentAccountId set by the caller.
    let accounts = [];
    try { accounts = await this.getAccounts(); } catch { /* non-fatal */ }
    if (!this.state.currentAccountId && accounts.length === 1) {
      this.state.currentAccountId = accounts[0].accountId || accounts[0].id;
    }

    return {
      userId: this.state.userId,
      userName: this.state.userName,
      isPendingApplicant: this.state.isPendingApplicant,
      paperUserName: this.state.paperUserName,
      apiBase: this.state.apiBase,
      portalPrefix: this.state.portalPrefix,
      brokerage,
      accounts,                                  // [{ accountId, ... }, ...]
      currentAccountId: this.state.currentAccountId,
    };
  }

  async signOut() {
    try {
      await this._post(this._portalUrl('logout'));
    } catch { /* ignore */ }
    // Clear session-significant state but keep nothing identifying.
    this.state = emptyState();
  }

  // Keep the session warm. Returns the parsed /tickle response.
  async tickle() {
    return this._expect200('tickle', await this._get(this._portalUrl('tickle')));
  }

  // ---------- post-login pipeline (internal) ----------
  async _validateSso() {
    const data = this._expect200(
      'sso/validate',
      await this._get(this._portalUrl('sso/validate?gw=1')),
    );
    if (data && typeof data === 'object') {
      if (data.USER_ID) this.state.userId = data.USER_ID;
      if (data.USER_NAME) this.state.userName = data.USER_NAME;
      if (typeof data.IS_PENDING_APPLICANT === 'boolean') {
        this.state.isPendingApplicant = data.IS_PENDING_APPLICANT;
      }
      if (data.PAPER_USER_NAME) this.state.paperUserName = data.PAPER_USER_NAME;
    }
    return data;
  }

  async _fetchK() {
    this._expect200('ssodh/init', await this._get(this._portalUrl('ssodh/init')));
    const st = this._expect200('ssodh/st', await this._get(this._portalUrl('ssodh/st')));
    if (!st || !st.st) throw new IbkrError('ssodh/st: no `st` in response', { stage: 'ssodh/st', body: st });
    this.state.kHex = st.st;
    return st.st;
  }

  async _publishTstToken() {
    if (!this.state.deviceId) this.state.deviceId = `${genDeviceRandom()}|00-00-00-00-00-00`;
    if (!this.state.kHex) throw new IbkrError('publishTstToken before fetchK');
    this.state.tstToken = generateTstToken(this.state.deviceId, this.state.kHex);
    const url = this._hostUrl(
      `/sso/Authenticator?ACTION=PUBLISH_TST&RESP_TYPE=JSON&DEVICE_ID=${encodeURIComponent(this.state.deviceId)}`,
    );
    try { await this._get(url); } catch { /* non-fatal */ }
  }

  async _brokerageAuthenticate({ maxLoops = 8 } = {}) {
    for (let loop = 0; loop < maxLoops; loop++) {
      const status = this._expect200(
        'iserver/auth/status',
        await this._get(this._portalUrl('iserver/auth/status')),
      );
      if (status.authenticated && status.competing === false) return status;
      if (!this.state.userName) throw new IbkrError('brokerageAuthenticate: no userName — run signIn / validate first');
      const post = {
        username: this.state.userName,
        machineId: genDeviceRandom(),
        compete: true,
      };
      const init = this._expect200(
        'iserver/auth/ssodh/init',
        await this._post(this._portalUrl('iserver/auth/ssodh/init'), post),
      );
      if (init.authenticated) continue;
      if (init.wait) { await SLEEP_MS(5000); continue; }
      if (init.error || !init.challenge) throw new IbkrError('iserver/auth/ssodh/init failed', { stage: 'iserver/auth/ssodh/init', body: init });
      if (!this.state.kHex) throw new IbkrError('no K — call fetchK first');
      const sk = computeSk(init.challenge, this.state.kHex);
      this._expect200(
        'iserver/auth/ssodh/response',
        await this._post(this._portalUrl('iserver/auth/ssodh/response'), { response: sk }),
      );
    }
    throw new IbkrError(`brokerageAuthenticate: not authenticated after ${maxLoops} loops`);
  }

  // Idempotent: bring the iserver brokerage tier up. Safe to call before
  // any action that needs it (order placement, secdef/search, etc.).
  //
  // Always pokes /iserver/accounts at the end — IBKR's order endpoints
  // (/iserver/account/orders, /iserver/account/order/status/{id}, etc.)
  // return 500 "Please query /accounts first" until that warm-up GET
  // has run at least once on this session.
  async ensureBrokerage({ force = false } = {}) {
    let st = null;
    if (!force) {
      st = this._expect200(
        'iserver/auth/status',
        await this._get(this._portalUrl('iserver/auth/status')),
      );
      if (!(st.authenticated && st.connected && st.competing === false)) st = null;
    }
    if (!st) {
      if (!this.state.userName) await this._validateSso();
      await this._fetchK();
      st = await this._brokerageAuthenticate();
    }
    // Warm-up; best-effort.
    try { await this._get(this._portalUrl('iserver/accounts')); } catch { /* ignore */ }
    return st;
  }

  // ---------- accounts / current-account selection ----------

  // Fetch /portfolio/accounts and cache the result on the session.
  // Pass { cache: true } to skip the network call when we already have
  // a list (used by the implicit accountId resolver).
  async getAccounts({ cache = false } = {}) {
    if (cache && Array.isArray(this.state.accountsCache)) return this.state.accountsCache;
    const r = this._expect200(
      'portfolio/accounts',
      await this._get(this._portalUrl('portfolio/accounts')),
    );
    const list = Array.isArray(r) ? r : [];
    this.state.accountsCache = list;
    this.state.accountsCacheAt = new Date().toISOString();
    return list;
  }

  // Currently-selected account id, or null if none has been set.
  getCurrentAccount() { return this.state.currentAccountId; }

  // Pin a current account. Validates against /portfolio/accounts unless
  // { skipValidation: true } is passed (e.g. when restoring state).
  // Returns the chosen id.
  async setCurrentAccount(accountId, { skipValidation = false } = {}) {
    if (!accountId) throw new IbkrError('setCurrentAccount: accountId required');
    if (!skipValidation) {
      const list = await this.getAccounts();
      const found = list.find((a) => (a.accountId || a.id) === accountId);
      if (!found) {
        throw new IbkrError(
          `setCurrentAccount: ${accountId} not in /portfolio/accounts (have: ${list.map((a) => a.accountId || a.id).join(', ')})`,
        );
      }
    }
    this.state.currentAccountId = accountId;
    return accountId;
  }

  // Forget the current selection. Subsequent calls fall back to "single
  // account auto-detect, else error".
  unsetCurrentAccount() { this.state.currentAccountId = null; }

  // Resolve the implicit accountId for portfolio / order operations.
  //   1. Caller passed one explicitly → use that.
  //   2. state.currentAccountId is set → use that.
  //   3. /portfolio/accounts returns exactly one row → use that
  //      (transparent single-account UX).
  //   4. Multiple accounts, none chosen → throw an IbkrError whose
  //      `stage` is 'no-account-selected' and whose `body.accounts`
  //      lists the choices. Callers / CLIs should catch this and
  //      surface it to the user.
  async _resolveAccountId(explicit) {
    if (explicit) return explicit;
    if (this.state.currentAccountId) return this.state.currentAccountId;
    const list = await this.getAccounts({ cache: true });
    if (list.length === 1) return list[0].accountId || list[0].id;
    if (list.length === 0) throw new IbkrError('no accounts on this session', { stage: 'no-accounts' });
    throw new IbkrError(
      `multiple accounts on this session — pick one with setCurrentAccount() ` +
      `(or pass accountId explicitly). Available: ` +
      list.map((a) => `${a.accountId || a.id}${a.accountTitle ? ` (${a.accountTitle})` : ''}`).join(', '),
      { stage: 'no-account-selected', body: { accounts: list } },
    );
  }

  // Back-compat: same as resolving the implicit id. Kept because the
  // old name was a public method; new code should rely on the implicit
  // resolution in getPositions / placeOrder / etc.
  async getDefaultAccountId() { return this._resolveAccountId(); }

  // Returns a normalised portfolio snapshot:
  //   { accountId, stocks, options, other, cash, errors }
  //
  // We don't gate on the meta endpoint's `brokerageAccess` field — it
  // reports false for paper accounts that still have perfectly readable
  // positions/ledger data (you can see your $1M paper cash in the web
  // portal while brokerageAccess is false on the same account). Instead
  // we just attempt every fetch and record per-endpoint failures in
  // `errors`. Empty positions arrays + empty cash means "no data".
  async getPositions(accountId) {
    if (!accountId) accountId = await this._resolveAccountId();
    const errors = {};

    const positions = [];
    for (let page = 0; page < 50; page++) {
      const res = await this._get(this._portalUrl(`portfolio/${encodeURIComponent(accountId)}/positions/${page}`));
      if (res.status !== 200) {
        if (page === 0) {
          errors.positions = `HTTP ${res.status}: ${typeof res.data === 'string' ? res.text.slice(0, 120) : JSON.stringify(res.data).slice(0, 120)}`;
        }
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

    let cash = [];
    try { cash = await this.getCash(accountId); }
    catch (e) { errors.cash = e.message; }

    return {
      accountId,
      stocks: byClass.STK || [],
      options: byClass.OPT || [],
      other: Object.fromEntries(Object.entries(byClass).filter(([k]) => k !== 'STK' && k !== 'OPT')),
      cash,
      errors,
    };
  }

  // /portfolio/{id}/ledger → normalised [{ ccy, cash, netLiq, unrealizedPnl, realizedPnl, excessLiq, settledCash }]
  async getCash(accountId) {
    if (!accountId) accountId = await this._resolveAccountId();
    const res = await this._get(this._portalUrl(`portfolio/${encodeURIComponent(accountId)}/ledger`));
    if (res.status !== 200 || !res.data || typeof res.data !== 'object') return [];
    return Object.entries(res.data).map(([ccy, l]) => ({
      ccy,
      cash: l.cashbalance,
      netLiq: l.netliquidationvalue,
      unrealizedPnl: l.unrealizedpnl,
      realizedPnl: l.realizedpnl,
      excessLiq: l.excessliquidity,
      settledCash: l.settledcash,
    }));
  }

  // ---------- orders ----------

  // ---------- securities lookup + quotes ----------

  // Multi-result symbol/name search. Returns the raw secdef list so
  // callers can disambiguate (multiple companies, multiple exchanges,
  // ADRs vs primary listings, etc.).
  //   { name: false } → search by ticker (default — symbol is exact).
  //   { name: true }  → search by company name (fuzzy).
  async searchSecurity(query, { name = false } = {}) {
    const qs = `symbol=${encodeURIComponent(query)}${name ? '&name=true' : ''}`;
    const res = await this._get(this._portalUrl(`iserver/secdef/search?${qs}`));
    if (res.status !== 200) {
      throw new IbkrError(`secdef/search ${query} → HTTP ${res.status}`,
        { stage: 'secdef/search', status: res.status, body: res.data });
    }
    const list = Array.isArray(res.data) ? res.data
      : (res.data?.secdef || res.data?.data || res.data?.results || []);
    return list.map((r) => ({
      conid: Number(r.conid),
      symbol: r.symbol,
      description: r.companyHeader || r.description || r.companyName || r.symbol,
      issuer: r.issuer,
      sections: r.sections || [], // [{secType, exchange, ...}]
    })).filter((r) => r.conid);
  }

  // Resolve a stock symbol → single conid via search (prefers STK).
  async resolveConid(symbol) {
    const list = await this.searchSecurity(symbol);
    if (!list.length) throw new IbkrError(`no security found for ${symbol}`);
    const stk = list.find((r) => r.sections.some((s) => s.secType === 'STK')) || list[0];
    return { conid: stk.conid, description: stk.description };
  }

  // Snapshot quote. Field codes are the IBKR Client Portal numeric IDs:
  //   31  Last price                7295  Volume
  //   84  Bid                       70    52-week high
  //   86  Ask                       71    52-week low
  //   85  Ask size                  7287  Day's high
  //   88  Bid size                  7288  Day's low
  //   7741 Change ($)               7762  Change (%)
  //   55  Symbol                    7051  Company name
  //
  // The endpoint requires being primed (first call may return only
  // metadata while it subscribes); we re-call up to `retries` times
  // when a field is missing.
  async getQuote(conid, {
    fields = [31, 84, 86, 88, 85, 7741, 7762, 7295, 70, 71, 7287, 7288, 55, 7051],
    retries = 3,
  } = {}) {
    if (!conid) throw new IbkrError('getQuote: conid required');
    const conids = String(conid);
    const fieldList = fields.join(',');
    let last = null;
    for (let i = 0; i <= retries; i++) {
      const res = await this._get(this._portalUrl(`iserver/marketdata/snapshot?conids=${conids}&fields=${fieldList}`));
      if (res.status !== 200) {
        throw new IbkrError(`marketdata/snapshot → HTTP ${res.status}`,
          { stage: 'marketdata/snapshot', status: res.status, body: res.data });
      }
      const row = Array.isArray(res.data) ? res.data[0] : null;
      last = row || {};
      // Has at least one real price field?
      if (row && (row['31'] || row['84'] || row['86'])) break;
      if (i < retries) await SLEEP_MS(700);
    }
    // Normalise into a friendly shape.
    return {
      conid: Number(conid),
      symbol: last['55'],
      name: last['7051'],
      last: parseFloat(last['31']),
      bid: parseFloat(last['84']),
      ask: parseFloat(last['86']),
      bidSize: parseFloat(last['88']),
      askSize: parseFloat(last['85']),
      changeAbs: parseFloat(last['7741']),
      changePct: parseFloat(last['7762']),
      volume: last['7295'],
      week52High: parseFloat(last['70']),
      week52Low: parseFloat(last['71']),
      dayHigh: parseFloat(last['7287']),
      dayLow: parseFloat(last['7288']),
      raw: last,
    };
  }

  // Historical OHLC bars. `period` accepts IBKR's syntax:
  //   1d, 5d, 1w, 1m, 3m, 6m, 1y, 2y, 5y
  // `bar`:
  //   1min, 2min, 3min, 5min, 10min, 15min, 30min, 1h, 2h, 3h, 4h, 8h,
  //   1d, 1w, 1m
  //
  // Returns { startTime, points: [{ t, o, h, l, c, v }, ...] }.
  async getHistory(conid, { period = '1y', bar = '1d', outsideRth = false } = {}) {
    if (!conid) throw new IbkrError('getHistory: conid required');
    const qs = `conid=${encodeURIComponent(conid)}&period=${encodeURIComponent(period)}&bar=${encodeURIComponent(bar)}&outsideRth=${outsideRth ? 'true' : 'false'}`;
    const res = await this._get(this._portalUrl(`iserver/marketdata/history?${qs}`));
    if (res.status !== 200) {
      throw new IbkrError(`marketdata/history → HTTP ${res.status}`,
        { stage: 'marketdata/history', status: res.status, body: res.data });
    }
    const data = res.data || {};
    const points = (data.data || []).map((d) => ({
      t: d.t, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v,
    }));
    return { startTime: data.startTime, period, bar, points };
  }

  // Convenience: %-change over the last N bars (or simply over the
  // whole returned period). Returns null if not enough data.
  async getChange(conid, { period = '1y', bar = '1d' } = {}) {
    const h = await this.getHistory(conid, { period, bar });
    if (h.points.length < 2) return null;
    const first = h.points[0].c;
    const last = h.points[h.points.length - 1].c;
    if (!first) return null;
    return { period, first, last, abs: last - first, pct: ((last - first) / first) * 100 };
  }

  // Place a single order. Walks the IBKR confirmation chain.
  //
  //   { accountId, conid|symbol, side, quantity, orderType,
  //     limitPrice?, stopPrice?, tif='DAY', outsideRth=false,
  //     onConfirm: async (msg) => boolean,    // default: () => true
  //     onProgress: (msg) => void }
  //
  // Returns the final iserver response array (one row per order).
  async placeOrder({
    accountId,
    conid, symbol,
    side, quantity, orderType,
    limitPrice, stopPrice,
    tif = 'DAY', outsideRth = false,
    onConfirm = async () => true,
    onProgress = () => {},
  } = {}) {
    if (!accountId) accountId = await this._resolveAccountId();
    if (!side || !/^(BUY|SELL)$/i.test(side)) throw new IbkrError('placeOrder: side must be BUY or SELL');
    if (!quantity || quantity <= 0) throw new IbkrError('placeOrder: quantity must be > 0');
    if (!orderType) throw new IbkrError('placeOrder: orderType required');
    if (/^LMT|^STP_LIMIT/i.test(orderType) && limitPrice == null) {
      throw new IbkrError(`placeOrder: ${orderType} requires limitPrice`);
    }
    if (/^STP/i.test(orderType) && orderType.toUpperCase() !== 'STP_LIMIT' && stopPrice == null) {
      throw new IbkrError(`placeOrder: ${orderType} requires stopPrice`);
    }
    if (!conid) {
      if (!symbol) throw new IbkrError('placeOrder: pass either conid or symbol');
      onProgress(`resolving conid for ${symbol}`);
      const r = await this.resolveConid(symbol);
      conid = r.conid;
      onProgress(`  → ${symbol} conid=${conid} (${r.description})`);
    }
    const order = {
      conid: Number(conid),
      orderType: orderType.toUpperCase(),
      side: side.toUpperCase(),
      quantity: Number(quantity),
      tif: tif.toUpperCase(),
      outsideRth: !!outsideRth,
    };
    if (limitPrice != null) order.price = Number(limitPrice);
    if (stopPrice != null) order.auxPrice = Number(stopPrice);

    onProgress(`POST iserver/account/${accountId}/orders`);
    let res = await this._post(
      this._portalUrl(`iserver/account/${encodeURIComponent(accountId)}/orders`),
      { orders: [order] },
    );
    if (res.status !== 200) throw new IbkrError(`order POST → HTTP ${res.status}: ${res.text.slice(0, 250)}`, { stage: 'orders', status: res.status, body: res.data });

    // Confirmation chain.
    let body = res.data;
    for (let i = 0; i < 10; i++) {
      const arr = Array.isArray(body) ? body : null;
      if (!arr || !arr.length) break;
      const first = arr[0];
      if (first.order_id || first.order_status) return arr;
      if (!first.id || !first.message) break;
      const msg = {
        id: first.id,
        message: Array.isArray(first.message) ? first.message.join('\n') : String(first.message),
        messageIds: first.messageIds || [],
      };
      const ok = await onConfirm(msg);
      onProgress(`reply ${msg.id} → ${ok ? 'confirmed' : 'cancelled'}`);
      res = await this._post(this._portalUrl(`iserver/reply/${encodeURIComponent(msg.id)}`), { confirmed: !!ok });
      if (res.status !== 200) throw new IbkrError(`reply ${msg.id} → HTTP ${res.status}`, { stage: 'reply', status: res.status, body: res.data });
      if (!ok) return [{ order_status: 'cancelled-by-caller', reply: first }];
      body = res.data;
    }
    return Array.isArray(body) ? body : [body];
  }

  // GET /iserver/account/orders — current order book for this session.
  // Optional filters: { status, accountId } applied client-side.
  async getOrders({ status, accountId } = {}) {
    const res = await this._get(this._portalUrl('iserver/account/orders'));
    if (res.status !== 200) throw new IbkrError(`orders → HTTP ${res.status}`, { stage: 'orders-list', status: res.status, body: res.data });
    let list = res.data?.orders || [];
    if (status) {
      const want = new Set((Array.isArray(status) ? status : [status]).map((s) => s.toLowerCase()));
      list = list.filter((o) => want.has(String(o.status || '').toLowerCase()));
    }
    if (accountId) list = list.filter((o) => o.acct === accountId || o.account === accountId);
    return list;
  }

  // Single-order status. IBKR exposes this as GET /iserver/account/order/status/{orderId}.
  async getOrderStatus(orderId) {
    if (!orderId) throw new IbkrError('getOrderStatus: orderId required');
    const res = await this._get(this._portalUrl(`iserver/account/order/status/${encodeURIComponent(orderId)}`));
    if (res.status !== 200) throw new IbkrError(`order/status → HTTP ${res.status}`, { stage: 'order-status', status: res.status, body: res.data });
    return res.data;
  }

  // DELETE /iserver/account/{accountId}/order/{orderId}
  async cancelOrder({ accountId, orderId } = {}) {
    if (!orderId) throw new IbkrError('cancelOrder: orderId required');
    if (!accountId) accountId = await this._resolveAccountId();
    const res = await this._http(
      'DELETE',
      this._portalUrl(`iserver/account/${encodeURIComponent(accountId)}/order/${encodeURIComponent(orderId)}`),
    );
    if (res.status !== 200) throw new IbkrError(`cancel ${orderId} → HTTP ${res.status}`, { stage: 'cancel', status: res.status, body: res.data });
    return res.data;
  }

  // GET /iserver/account/trades — recent trades for this session.
  async getTrades() {
    const res = await this._get(this._portalUrl('iserver/account/trades'));
    if (res.status !== 200) throw new IbkrError(`trades → HTTP ${res.status}`);
    return Array.isArray(res.data) ? res.data : (res.data?.trades || []);
  }
}

export { IbkrError, emptyState };
