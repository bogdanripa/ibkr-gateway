#!/usr/bin/env node
// `node cli/auth.js`  — bootstrap an IBKR session from browser cookies.
//
// Why "paste cookies" and not "username + password":
//   The IBKR SSO login page is a JS-rendered multi-step form that may
//   include captcha and 2FA prompts. Replicating it headlessly in pure
//   Node is fragile (the form drifts). The robust approach is to log
//   in once in your browser, copy the cookies for api.ibkr.com, and
//   let the Node CLI run the post-login SSODH handshake for you.
//
// Usage:
//   1.  Open https://www.interactivebrokers.com/sso/Login?forwardTo=22
//       in your browser and log in normally.
//   2.  Open DevTools → Application → Cookies → https://api.ibkr.com
//       (also check gdcdyn.interactivebrokers.com if you used that host).
//   3.  Copy every cookie value and paste them as a single string when
//       prompted (the same format your browser sends in the Cookie
//       header, e.g. `XYZAB=abc; XYZAB_AM.LOGIN=abc; REGION=usr; …`).
//   4.  The CLI will run validate → ssodh/init → ssodh/st →
//       /iserver/auth/ssodh/{init,response} → /tickle and persist the
//       resulting session to ~/.ibkr-cli/session.json.
//
// You can also pass the cookies inline:
//   node cli/auth.js "XYZAB=…; XYZAB_AM.LOGIN=…; REGION=usr; USERID=12345"

import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, exit } from 'node:process';
import { loadSession, saveSession, sessionPath } from './lib/session.js';
import { establishSession } from './lib/auth.js';

function parseCookieHeader(line) {
  const out = {};
  for (const part of line.split(';')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const name = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (!value) continue;
    out[name] = { value, path: '/', secure: true };
  }
  return out;
}

async function readCookieLine() {
  const inline = argv.slice(2).join(' ').trim();
  if (inline) return inline;
  const rl = createInterface({ input: stdin, output: stdout });
  console.error('Paste cookie header (single line), then press Enter:');
  const line = await rl.question('cookies> ');
  rl.close();
  return line;
}

const line = await readCookieLine();
const parsed = parseCookieHeader(line);
if (!parsed.XYZAB && !parsed['XYZAB_AM.LOGIN']) {
  console.error('error: pasted cookies must contain at least XYZAB or XYZAB_AM.LOGIN');
  exit(2);
}
// If user only gave one of the two XYZAB variants, mirror it like
// SsoService.stComplete does (cm.add("XYZAB", v, "/") and likewise).
if (parsed['XYZAB_AM.LOGIN'] && !parsed.XYZAB) {
  parsed.XYZAB = { ...parsed['XYZAB_AM.LOGIN'] };
}
if (parsed.XYZAB && !parsed['XYZAB_AM.LOGIN']) {
  parsed['XYZAB_AM.LOGIN'] = { ...parsed.XYZAB };
}

const session = await loadSession();
session.cookies = { ...session.cookies, ...parsed };
await saveSession(session);

console.error('→ running post-login pipeline…');
try {
  const status = await establishSession(session);
  console.error(`✓ authenticated  (user=${session.userName ?? '?'} id=${session.userId ?? '?'})`);
  console.error(`  saved to ${sessionPath()}`);
  console.error(`  iserver status: authenticated=${status.authenticated} competing=${status.competing} connected=${status.connected}`);
} catch (e) {
  console.error('✗ ' + (e.message || e));
  exit(1);
}
