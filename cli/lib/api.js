// Thin HTTPS client for api.ibkr.com that maintains a cookie jar in the
// same way CookieManager + HttpProxy in the Java gateway do.

import { request } from 'undici';
import { saveSession } from './session.js';

// Defaults — used when the session hasn't been pinned to a host yet
// (i.e. before login finishes). Live accounts end up on api.ibkr.com
// under /v1/api; paper accounts on *.interactivebrokers.com under
// /portal.proxy/v1/portal.
export const DEFAULT_BASE = 'https://api.ibkr.com';
export const DEFAULT_PORTAL_PREFIX = '/v1/api';
export const USER_AGENT = 'ClientPortalGW/1';

// Build a full URL from a portal-relative path like "sso/validate?gw=1"
// or "iserver/auth/status", using the host + path-prefix pinned on the
// session (set by lib/login.js after observing the post-login URL).
export function portalUrl(session, relPath) {
  const base = session?.apiBase || DEFAULT_BASE;
  const prefix = session?.portalPrefix || DEFAULT_PORTAL_PREFIX;
  const tail = relPath.startsWith('/') ? relPath : '/' + relPath;
  return base + prefix + tail;
}

// Host-relative URL (no portalPrefix). Used for /sso/* endpoints that
// live at the host root.
export function hostUrl(session, relPath) {
  const base = session?.apiBase || DEFAULT_BASE;
  const tail = relPath.startsWith('/') ? relPath : '/' + relPath;
  return base + tail;
}

function parseSetCookie(line) {
  // Set-Cookie: name=value; Path=/; Secure; HttpOnly; ...
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

export function captureCookies(session, headers) {
  const raw = headers['set-cookie'];
  if (!raw) return;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const line of list) {
    const c = parseSetCookie(line);
    if (!c) continue;
    if (!c.cookie.value) continue;
    session.cookies[c.name] = c.cookie;
  }
}

export function cookieHeader(session, urlPath) {
  // Filter by path-prefix the same way CookieManager.cookieList does.
  const out = [];
  for (const [name, c] of Object.entries(session.cookies)) {
    const p = c.path || '/';
    if (!urlPath.startsWith(p) && p !== '/') continue;
    out.push(`${name}=${c.value}`);
  }
  return out.join('; ');
}

async function call(session, method, url, { body, contentType, headers = {} } = {}) {
  const u = url.startsWith('http')
    ? new URL(url)
    : new URL((session?.apiBase || DEFAULT_BASE) + url);
  const cookies = cookieHeader(session, u.pathname);
  const reqHeaders = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    ...headers,
  };
  if (cookies) reqHeaders.Cookie = cookies;
  if (body && contentType) reqHeaders['Content-Type'] = contentType;

  const res = await request(u, { method, headers: reqHeaders, body });
  captureCookies(session, res.headers);

  const ct = res.headers['content-type'] || '';
  const text = await res.body.text();
  let data = text;
  if (ct.includes('application/json')) {
    try { data = JSON.parse(text); } catch { /* leave as text */ }
  }
  return { status: res.statusCode, headers: res.headers, data, text };
}

export const api = {
  get: (s, p, opts) => call(s, 'GET', p, opts),
  post: (s, p, json, opts = {}) =>
    call(s, 'POST', p, {
      ...opts,
      body: JSON.stringify(json),
      contentType: 'application/json',
    }),
  postForm: (s, p, form, opts = {}) =>
    call(s, 'POST', p, {
      ...opts,
      body: new URLSearchParams(form).toString(),
      contentType: 'application/x-www-form-urlencoded',
    }),
};

export async function persist(session) {
  await saveSession(session);
}
