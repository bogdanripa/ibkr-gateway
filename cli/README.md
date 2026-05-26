# `cli/` — a JVM-free Node port of the IBKR Client Portal Gateway

A single Node class (`IbkrClient`) that talks directly to the IBKR
Client Portal Web API using the same session protocol the Java Client
Portal Gateway uses internally — no JVM, no IBeam.

Background on **how** the protocol works and **why** see
[`../docs/cpg-protocol.md`](../docs/cpg-protocol.md).

## Setup

```bash
npm install                      # pulls playwright (~6 MB)
npx playwright install chromium  # one-time Chromium download (~170 MB)
```

## CLI usage

```bash
# Login — paper or live (default live). State persisted at ~/.ibkr-cli/session.json.
node cli/login.js --mode paper
node cli/login.js --mode live --headed             # visible Chromium (2FA / debug)
IBKR_USERNAME=u IBKR_PASSWORD=p node cli/login.js  # non-interactive

# Read positions + cash:
node cli/positions.js
node cli/positions.js --account DUQ443672

# Place orders:
node cli/place-order.js --symbol AAPL --side BUY --qty 1 --type MKT --yes
node cli/place-order.js --symbol AAPL --side BUY --qty 1 --type LMT --limit 150
node cli/place-order.js --conid 265598 --side SELL --qty 1 --type MKT --outside-rth

# Order management:
node cli/orders.js list
node cli/orders.js list --status Filled,PreSubmitted
node cli/orders.js status 1194667540
node cli/orders.js cancel 1194667540
```

## Library usage

`IbkrClient` is a single class. State lives on the instance; you choose
how to persist it (file, DB, env). See `cli/lib/client.js` for the full
API; here's the shape:

```js
import { IbkrClient } from './cli/lib/client.js';
import { loadState, saveState } from './cli/lib/session-file.js'; // optional helper

const c = new IbkrClient({ state: await loadState() });

// 1) sign in (drives Playwright + post-login pipeline)
const info = await c.signIn({
  username, password,
  mode: 'paper',          // 'paper' | 'live'
  headed: false,
  onProgress: console.log,
});
await saveState(c.getState());

// 2) account / portfolio
const accounts = await c.getAccounts();           // [{accountId, accountTitle, ...}]
const acct = await c.getDefaultAccountId();
const snapshot = await c.getPositions(acct);
// → { accountId, brokerageAccess, stocks, options, other, cash }

const cash = await c.getCash(acct);
// → [{ ccy, cash, netLiq, unrealizedPnl, realizedPnl, excessLiq, settledCash }]

// 3) orders
await c.ensureBrokerage();    // make sure iserver bridge is up

const placed = await c.placeOrder({
  accountId: acct,
  symbol: 'AAPL',             // OR conid: 265598
  side: 'BUY',
  quantity: 1,
  orderType: 'MKT',           // 'MKT' | 'LMT' | 'STP' | 'STP_LIMIT' | 'MIT' | …
  // limitPrice: 150,         // for LMT / STP_LIMIT
  // stopPrice: 145,          // for STP / STP_LIMIT
  tif: 'DAY',                 // 'DAY' | 'GTC' | 'IOC' | 'OPG'
  outsideRth: false,
  onConfirm: async ({ message }) => {
    console.log('IBKR warning:', message);
    return true;              // return false to abort
  },
});
// → [{ order_id, order_status, ... }]

const orders = await c.getOrders({ status: ['PreSubmitted', 'Submitted'] });
const status = await c.getOrderStatus('1194667540');
await c.cancelOrder({ orderId: '1194667540', accountId: acct });

// 4) state plumbing
const snap = c.getState();    // serialisable plain object
c.setState(snap);             // restore on next process start
c.isSignedIn();               // do we have XYZAB cookies?

// 5) session management
await c.tickle();              // keep-alive
await c.signOut();             // POST /logout + clear state
```

### `mode` argument

| `mode`  | Effect |
|---------|--------|
| `live`  | Submits with the Live/Paper toggle on Live (the form default). Use for real accounts. |
| `paper` | Flips the toggle to Paper before submitting. Required for paper-only usernames — without it IBKR returns *"You have selected the Live Account Mode, but the specified user is a Paper Trading user."* |

### 2FA

The login flow is the same as the Java CPG: it doesn't bypass 2FA. For
IBKey push, run with `headed: true` and tap Approve on your phone
within the timeout. For code-based 2FA (SCC, SMS), you currently need
to extend `cli/lib/browser-login.js` to read the code — see the
selector map in that file's header (`#xyz-field-bronze/silver/gold/temp-response`).

### Account-state notes

- `result.isPendingApplicant: true` → IBKR application not yet
  approved. `getPositions()` returns `brokerageAccess: false` and the
  portfolio endpoints return HTTP 500.
- `result.brokerage.state: 'unavailable'` → the iserver brokerage
  handshake failed (typical for pending-applicant accounts). Reading
  works; `placeOrder()` will fail.

## File layout

```
cli/
├── login.js              # CLI: sign in
├── positions.js          # CLI: list positions / cash
├── place-order.js        # CLI: place a single order
├── orders.js             # CLI: list / status / cancel orders
└── lib/
    ├── client.js         # IbkrClient class (all functionality)
    ├── browser-login.js  # Playwright driver for /sso/Login
    ├── sso-math.js       # SHA-1, compute_sk, TST derivation
    └── session-file.js   # ~/.ibkr-cli/session.json helper
```

State is persisted to `~/.ibkr-cli/session.json` (mode 0600) by the
bundled CLIs. Library users use `client.getState()` / `setState()` to
plug in their own storage.
