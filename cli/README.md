# `cli/` — interactive CLI on top of the IBKR client module

A menu-driven Node CLI that talks to IBKR via the reusable module at
[`../lib/ibkr/`](../lib/ibkr/). No JVM, no IBeam — just Node + Playwright
for the browser-mediated login.

## Strict layering

| Layer | Lives in | Knows about |
|---|---|---|
| **Module** (reusable) | [`lib/ibkr/`](../lib/ibkr/) | HTTP, cookies, IBKR protocol. No CLI, no readline, no `process.exit`. |
| **CLI** | [`cli/ibkr.js`](./ibkr.js) | Menus, prompts, formatting, persistence of state to `~/.ibkr-cli/session.json`. |
| **CLI helpers** | [`cli/lib/`](./lib/) | `prompt.js` (readline wrappers), `session-file.js` (state ↔ disk). |

The same module will be imported by the planned web gateway — see
[`../docs/cpg-protocol.md`](../docs/cpg-protocol.md) for the wire-level
spec.

## Setup

```bash
npm install                      # installs playwright
npx playwright install chromium  # one-time, ~170 MB
```

## Usage

```bash
node cli/ibkr.js
```

Flow:

1. If `~/.ibkr-cli/session.json` exists, asks whether to reuse.
2. Otherwise prompts for mode (paper/live), username, password (masked),
   and whether to open the browser visibly (needed if your account
   requires IBKey 2FA push).
3. Drops into the top-level menu:

```
── Main (user=…, account=…) ──
  1. Positions
  2. Orders
  3. Accounts
  4. Sign out (forget saved session)
  9. Exit
```

**`9` always means "go back" (or "exit" at the top level).**

Sub-menus:

```
── Orders ──
  1. List open orders
  2. Place new order
  3. Check order status
  4. Cancel order
  9. Back
```

```
── Accounts (current=…) ──
  1. List accounts
  2. Set current account
  3. Unset current account
  9. Back
```

### Multi-account

If your IBKR user has multiple sub-accounts, pick one via **Accounts →
Set current account**. The choice persists into `session.json`, and
every other action uses it implicitly. With a single account this is
auto-set on sign-in.

### Order placement

The order-entry sub-menu walks you through symbol / side / qty / type
/ limit / stop / TIF / outside-RTH. IBKR's pre-trade warnings
("after-hours order", "margin warning", etc.) are surfaced one at a
time; each is shown verbatim and asked y/N. The order is only
submitted after a final review screen.

### 2FA

Same model as the Java CPG: this CLI doesn't bypass 2FA. Answer
"yes" to "Open browser visibly?" and complete the IBKey push (or
SCC/SMS code) in the window that appears. After IBKR's success
redirect, the CLI takes over.

## Scripting

If you need non-interactive scripting, import the module directly —
the CLI is just one consumer:

```js
import { IbkrClient } from '../lib/ibkr/index.js';

const c = new IbkrClient();
await c.signIn({ username, password, mode: 'paper' });
console.log(await c.getPositions());
const r = await c.placeOrder({ symbol: 'AAPL', side: 'BUY', quantity: 1, orderType: 'MKT' });
console.log(r);
```

See [`../lib/ibkr/client.js`](../lib/ibkr/client.js) for the full API.

## File layout

```
cli/
├── ibkr.js                 # the interactive CLI (one entry point)
├── lib/
│   ├── prompt.js           # ask / askPassword / yesNo / menu (readline)
│   └── session-file.js     # ~/.ibkr-cli/session.json load/save/clear
└── README.md               # this file
```

The reusable module lives in [`../lib/ibkr/`](../lib/ibkr/):

```
lib/ibkr/
├── index.js                # public export — { IbkrClient, IbkrError }
├── client.js               # IbkrClient class
├── browser-login.js        # Playwright /sso/Login driver
└── sso-math.js             # SHA-1, compute_sk, TST derivation
```
