# IBKR Client Portal Gateway — protocol notes

Reverse-engineered from the official `clientportal.gw` (jar
`ibgroup.web.core.iblink.router.clientportal.gw.jar`, build
`a27ed421…2023-04-24`) decompiled with CFR.

The Gateway itself is a thin Vert.x reverse proxy in front of
`api.ibkr.com` (or the legacy `gdcdyn.interactivebrokers.com`). All
"intelligence" it adds on top of plain HTTPS proxying is:

1. A small cookie jar (`CookieManager`).
2. A two-stage auth orchestrator (`SsoService` + `ClientPortalService`).
3. A `/tickle` keep-alive on a 30-second timer.

There is **no** server-side state or token issued by the Gateway. The
"session" *is* the cookie jar + a derived `K` BigInteger held in memory.

---

## 1. Endpoints (verbatim from `ServiceEndPoints.class`)

Below, `{base}` = `https://api.ibkr.com` (or gdcdyn host) and `{env}` = `v1`.
On the api.ibkr.com host the prefix is `/v1/api`; on gdcdyn it is `/v1/portal`.
The decompiled router maps either to the same backend.

| Purpose                       | Method | Path                                                  |
| ----------------------------- | ------ | ----------------------------------------------------- |
| Login page (browser)          | GET    | `/sso/Login?forwardTo=22&RL=1&ip2loc=US`              |
| SSO ping (keep-alive #1)      | GET    | `/sso/ping`                                           |
| TST publish                   | GET    | `/sso/Authenticator?ACTION=PUBLISH_TST&RESP_TYPE=JSON&DEVICE_ID=…` |
| TST challenge init            | GET    | `/sso/AuthenticateST?ACTION=INIT&SERVICE=AM.LOGIN&UID=…&DEVICE_ID=…` |
| TST challenge complete        | GET    | `/sso/AuthenticateST?ACTION=COMPLETE&SERVICE=AM.LOGIN&UID=…&CHALLENGE_RESPONSE=…` |
| Validate web session          | GET    | `{base}/v1/api/sso/validate?gw=1`                     |
| User info                     | GET    | `{base}/v1/api/one/user`                              |
| SSODH init (web)              | GET    | `{base}/v1/api/ssodh/init`                            |
| SSODH get K                   | GET    | `{base}/v1/api/ssodh/st`                              |
| Iserver auth status           | GET    | `{base}/v1/api/iserver/auth/status`                   |
| Brokerage SSODH init          | POST   | `{base}/v1/api/iserver/auth/ssodh/init`               |
| Brokerage SSODH response      | POST   | `{base}/v1/api/iserver/auth/ssodh/response`           |
| Reauthenticate                | POST   | `{base}/v1/api/iserver/reauthenticate`                |
| Tickle (keep-alive #2, 30 s)  | GET    | `{base}/v1/api/tickle`                                |
| Logout                        | POST   | `{base}/v1/api/logout`                                |
| Accounts list                 | GET    | `{base}/v1/api/iserver/accounts`                      |
| Validate accounts             | POST   | `{base}/v1/api/portfolio/validate`                    |

---

## 2. Cookies that matter (`CookieManager.allowed`)

```
URL_PARAM  RL          JSESSIONID  cp     cp.qa  api    api.nn
api.alpha  portal      cp.alpha    cp.beta USERID XYZAB  REGION
XYZAB_AM.LOGIN         web
```

The pairs that carry the actual session identity:

- **`XYZAB`** — login session token (the "I am bogdanripa, IBKR knows it")
- **`XYZAB_AM.LOGIN`** — the same value, scoped to the AM.LOGIN service
- **`USERID`** — numeric IBKR user id
- **`REGION`** — data centre (e.g. `usr`, `cgb`)
- **`JSESSIONID`** (path `/sso` *and* path `/AccountManagement`) — Jetty session
- **`web`** — set on first hit to `/sso/Login`

A request only sends cookies whose `path` is a prefix of the request URL
(`CookieManager.cookies(true, path)`).

The `XYZAB` cookies are also captured from **client** requests that hit
`/sso/*` paths (`HttpProxy.internalProxy`, line 112), which is how the
Gateway picks up cookies set client-side (e.g. by the JS login page).

---

## 3. Auth flow

### 3.1 Browser-driven login (the part you can't dodge cleanly)

1. Browser → `GET https://localhost:5000/`
2. CPG → `302` to `/sso/Login?forwardTo=22&RL=1&ip2loc=US`
3. CPG proxies the IBKR login page; user enters username + password (+
   2FA on accounts that have it). IBKR sets the cookies above.
4. On success the IBKR backend redirects through `/sso/Dispatcher`
   (`GatewayHttpProxy.generalHandler`, line 143 — a `302` with that path
   triggers `onLoggedIn()`).

For a **2FA-free secondary username** (the kind this project mandates) it
is possible to POST credentials directly to the IBKR login form without a
browser, but the form's field names + hidden tokens drift; the safest
headless approach is still a one-shot Playwright/Puppeteer login or
manually pasting cookies from devtools.

### 3.2 Post-login pipeline (the part we re-implement in Node)

Triggered after the browser drops `XYZAB` into the jar.

```
loginToCp():
  GET  /v1/api/sso/validate?gw=1            → { USER_ID, USER_NAME, … }
  GET  /v1/api/one/user                      (informational)
  ssoDHInit():
    GET  /v1/api/ssodh/init                  → { success: true, … }
    GET  /v1/api/ssodh/st                    → { st: "<hex>" }   ← K
  → ON_SSODH_COMPLETED:
       ssoService.setTstToken()              # see §4 (TST)
       cpService.setK(K)                     # triggers getStatus()
```

`getStatus()` calls `GET /v1/api/iserver/auth/status`. The reply is:

- `{ authenticated:true, competing:false, ... }` → we're done, fetch
  `/v1/api/iserver/accounts`, start the 30 s tickle.
- `{ authenticated:false, ... }` → run `authenticateBrokerage()`.

`authenticateBrokerage()`:

```
POST /v1/api/iserver/auth/ssodh/init
  { username: USER_NAME, machineId: <8 hex>, compete: true }
→  { challenge: "<hex>" }       (or { wait:true } → retry in 5 s)
   sk = SHA1(challengeHex + KHex)             # SsoCombined.compute_sk
POST /v1/api/iserver/auth/ssodh/response
  { response: sk }
→ same auth-status object, recurse into processAuthStatus()
```

### 3.3 Keep-alive

Two independent timers:

- `SsoService` pings `GET /sso/ping` every `ssoPing` minutes (default 5).
- `ClientPortalService` calls `GET /v1/api/tickle` every `tickleDelay`
  ms (default 30 000). The tickle reply includes
  `{ iserver: { authStatus: { authenticated, connected, ... } } }`. If
  `connected && !authenticated` → CPG auto-logouts and re-runs login.

---

## 4. The crypto: `SsoCombined` / `SsoMath`

It's a hand-rolled SHA-1 in plain JS-style integer ops, used in two
places. The Java implementation is bit-for-bit reproducible with
`crypto.createHash('sha1')` once you understand the input encoding.

### 4.1 `compute_sk(seed, verifier)` — challenge response

```
hashin = seed.toString(16) + verifier.toString(16)
return sha1_hex(hashin)        # ← bytes are interpreted as HEX digits
```

Important quirk: the `hex2blks_SHA1` routine treats `hashin` as a string
of hex *characters* (one char = 4 bits), packs **pairs of hex chars into
one byte**, and feeds those bytes to SHA-1. So the SHA-1 input is
`Buffer.from(hashin, 'hex')`, not `Buffer.from(hashin, 'utf8')`. If the
combined length is odd, a leading `'0'` is prepended.

### 4.2 `generateTSTK(deviceId, K)` — TST token

```
tag1  = hexEncode(utf8Bytes(deviceId + "TST"))   # each codepoint → hex
tag1  = trimLeadingHexZeros(tag1)
Khex  = trimLeadingHexZeros(K.toString(16))
TSTK  = sha1_hex(Buffer.from(tag1 + Khex, 'hex'))
```

`Device.genRandom()` is just:

```java
String.format("%08x", 100_000_000 + r.nextInt(999_999_999))
```

The full `deviceId` is `<genRandom>|<MAC-with-dashes>`.

### 4.3 `calculate_K(A, b, p)` — *not used in this flow*

`SsoCombined.calculate_K = SHA1(A.modPow(b, p).toString(16))` would be a
client-side Diffie-Hellman; the live protocol skips it because the
server hands us `K` directly via `GET /ssodh/st`.

---

## 5. What the "session" actually is

To resume a session in any HTTP client you need exactly:

- The cookie jar with at least `XYZAB`, `XYZAB_AM.LOGIN`, `USERID`,
  `REGION`, `JSESSIONID` (the two scoped variants).
- `K` (BigInt) — used to answer brokerage SSODH challenges.
- A persistent `deviceId` and `tstToken` if you want the TST
  reauthentication path (optional; not required just to read positions).

That's it. There is no bearer token, no OAuth, no JWT — the cookies plus
the in-memory `K` are everything.

---

## 6. Useful API endpoints (from `cpwebapi` docs, confirmed against gw)

For this CLI we only need:

- `GET /v1/api/portfolio/accounts` — list `accountId`s
- `GET /v1/api/portfolio/{accountId}/positions/{pageId}` — pages of 30,
  rows for stocks, options, futures, etc. Field `assetClass` tells you
  which (`STK`, `OPT`, `FUT`, `WAR`, `CASH`, …).
- `GET /v1/api/portfolio/{accountId}/ledger` — cash balances per
  currency.
