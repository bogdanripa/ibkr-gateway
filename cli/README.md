# `cli/` — a JVM-free Node port of the IBKR Client Portal Gateway

This is a small Node CLI that talks directly to `api.ibkr.com` using the
same session protocol the Java Client Portal Gateway uses internally, so
you don't need a JVM (or IBeam) running to read your account.

Background on **how** the protocol works and **why** it's split the way
it is, see [`../docs/cpg-protocol.md`](../docs/cpg-protocol.md).

## What it does (and doesn't)

✅ Implements, in pure Node:

- Cookie-jar management (matches `CookieManager` in the Java gw)
- `sso/validate` → `ssodh/init` → `ssodh/st` (fetch the shared `K`)
- TST token derivation (`SsoCombined.calcSHA1Hex` + `TstTokenUtils.generateTSTK`)
- `iserver/auth/ssodh/init` + `…/response` brokerage handshake
- `/tickle` keep-alive
- `GET /portfolio/{accountId}/positions/{page}` + `/ledger` rendering

For the **browser login** step (where IBKR renders the JS form with
potential captchas / 2FA prompts) we drive a real headless Chromium via
Playwright — the same approach IBeam takes — instead of trying to
re-implement IBKR's `/sso/Login` JS in HTTP. Everything *after* login
is plain Node.

## Setup

```bash
npm install                      # pulls playwright (~6 MB)
npx playwright install chromium  # one-time Chromium download (~170 MB)
```

The username you log in with **must be 2FA-free** (an IBKR secondary
username) — see `SPEC.md` §2. A 2FA push can't be answered headlessly.

## Usage

```bash
# Interactive login (prompts for username + password, password masked):
node cli/login.js
# Pass --headed to watch the browser, useful for debugging selector drift:
node cli/login.js --headed
# Or use env vars (CI):
IBKR_USERNAME=myuser IBKR_PASSWORD=… node cli/login.js

# Once authenticated, read positions / cash:
node cli/positions.js
```

If IBKR ever rolls a new form layout you can override the selectors
without code changes (see `cli/lib/login.js` header):

```bash
IBKR_LOGIN_USER_SEL='#user_name_v2' node cli/login.js --headed
```

### Fallback: bootstrap from browser cookies

If you can't run Playwright, you can copy cookies out of your real
browser instead:

```bash
# DevTools → Application → Cookies → https://api.ibkr.com → copy as a
# single "name=value; name=value; …" line, then:
node cli/auth.js
node cli/auth.js "XYZAB=…; XYZAB_AM.LOGIN=…; REGION=usr; USERID=12345"
```

State is persisted to `~/.ibkr-cli/session.json` (mode 0600).

## File layout

```
cli/
├── login.js         # entrypoint: full login (Playwright + post-login)
├── auth.js          # entrypoint: bootstrap from pasted cookies (fallback)
├── positions.js     # entrypoint: list positions + cash ledger
└── lib/
    ├── sso-math.js  # SHA-1 helpers, compute_sk, TST derivation
    ├── session.js   # persistent session jar
    ├── api.js       # undici HTTPS w/ cookie filtering
    ├── login.js     # Playwright Chromium driver for /sso/Login
    └── auth.js      # post-login pipeline (validate → ssodh → brokerage)
```
