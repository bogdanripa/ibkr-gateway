# IBKR Gateway Broker — Product & Implementation Spec

**Status:** Draft v1.3 · For implementation via Claude Code · Credential model: A (resolved) · API shape: 1 connection per API key (resolved) · Datastore: Firestore (resolved) · Human auth: Firebase Auth (resolved)
**Owner:** Bogdan Ripa

---

## 1. Summary

A service that lets multiple users connect their own Interactive Brokers (IBKR)
accounts and then, through a single uniform HTTP API, list positions (including
cash), place orders, and check order status.

The system is a **session broker**: it manages a pool of IBKR Client Portal
Gateway processes on a host, one live process per connected IBKR account, and
routes authenticated API-key traffic to the correct process.

This document is the build spec. It assumes the reader has not seen the prior
research and states the constraints explicitly.

---

## 2. Background & hard constraints

These are properties of IBKR's platform, not design choices. The architecture
exists *because* of them.

1. **No direct cloud API.** The IBKR Web API (Client Portal API) is not called
   directly. Each session runs through the **Client Portal Gateway** — a Java
   process that holds one authenticated session and proxies requests to IBKR.
   Application code talks to the Gateway over local HTTP.
2. **One session per IBKR username, enforced globally.** A username can have
   only one brokerage (trading-enabled) session across all IBKR products (TWS,
   mobile, Client Portal). Therefore: **one Gateway process per connected
   account.** There is no multiplexing.
3. **OAuth is not available to retail accounts.** As of early 2025, IBKR's
   position is that retail clients are only approved to use the Client Portal
   Gateway; OAuth 2.0 for individuals is "under consideration, no ETA." This
   means login **cannot** be a pure token exchange. See §10 for the migration
   path if/when this changes.
4. **Login requires real credentials.** The Gateway authenticates with an IBKR
   username/password. There is no service-account token. The system stores each
   user's credentials and injects them headlessly at spawn (Model A, §2.1).
   **Consequence:** headless injection cannot satisfy an interactive 2FA push,
   so every connected IBKR username must be 2FA-free. This is a hard onboarding
   precondition — see §9.1.
5. **Sessions are fragile.** Even with a correct 30-second keep-alive
   ("tickle"), sessions time out, drop, or refuse to re-authenticate and need
   intervention. The system must treat session loss as normal, not exceptional.
6. **IBKR Pro accounts only.** The Web API does not support IBKR Lite accounts.

### 2.1 Credential custody decision — RESOLVED: Model A

The system uses **Model A — operator-stored credentials**.

- **Model A (chosen).** The user provides their IBKR username/password once at
  onboarding. The system stores the credential set in GCP Secret Manager and
  injects it into the Gateway process at spawn time. `/connect` is fully
  automated and unattended; a dropped session self-heals without human
  involvement.
- **Model B (rejected).** User logs in via browser each time a session is cold;
  no credentials stored. Rejected because it **cannot support unattended
  operation** — a session that dies outside working hours stays dead until a
  human logs in, which blocks a scheduled autonomous trading workload. Recorded
  in §10 so it is not re-litigated.

**Why Model A:** the primary workload is an autonomous trading system that runs
on a schedule and must reconnect on its own (e.g. a session drops overnight and
must be live before market open). Only Model A delivers that. The cost —
credential custody — is accepted and mitigated; see §6.1 and §12.

> **Legal context.** This system is for the operator (Bogdan) and a small group
> of personal acquaintances ("friends"), not a public product. Users will
> accept explicit written terms acknowledging that they have voluntarily
> provided their IBKR credentials, that the operator stores them to enable
> automated access, and that they accept the associated risk. This is the basis
> on which Model A's custody risk is accepted.
>
> This materially lowers — but does not formally eliminate — the regulatory
> question: operating credentialed automated access for third parties can still
> touch MiFID II investment-services / custody concepts in the EU/Romania even
> among acquaintances. The spec proceeds on the stated assumption (closed group,
> informed consent, signed terms). If the user group ever broadens beyond
> personal acquaintances, this assumption breaks and the question must be
> revisited with qualified legal advice. This spec does not constitute legal
> advice. See §12 item 4.

---

## 3. Goals & non-goals

### Goals (v1)

- Multiple users, each connecting one or more IBKR accounts.
- Per-connection API keys (issuable, revocable). One API key maps to exactly
  one IBKR connection.
- Uniform REST API for: list positions + cash, place order, get order status,
  list live orders, cancel order.
- Implicit connect: trading endpoints auto-spawn a session if one isn't live.
  An explicit `/v1/connect` exists as an optional warm-up.
- Survive control-plane (proxy) restarts without losing usable state.

### Non-goals (v1)

- Streaming market data / WebSocket passthrough.
- Horizontal scale across multiple host VMs (single VM in v1; see §9).
- Historical reporting, funding, account opening.
- TWS API / socket transport (see §10 for why CP Gateway was chosen over it).
- Becoming a registered IBKR advisor/introducing broker (the *sanctioned*
  multi-tenant path; out of scope but noted in §10).

---

## 4. Architecture overview

Single VM, three logical components plus a process pool.

```
                    ┌──────────────────────────────────────────┐
                    │                  HOST VM                  │
                    │                                            │
   client ──HTTPS──▶│  ┌────────────┐      ┌──────────────────┐  │
  (API key)         │  │   PROXY    │      │   SUPERVISOR     │  │
                    │  │  (routing, │◀────▶│ (spawn, health,  │  │
                    │  │   auth)    │      │  keep-alive)     │  │
                    │  └─────┬──────┘      └────────┬─────────┘  │
                    │        │                     │            │
                    │        │  localhost:PORT      │ spawns     │
                    │        ▼                     ▼            │
                    │  ┌──────────────────────────────────────┐  │
                    │  │   GATEWAY POOL (1 process / account)  │  │
                    │  │  :5001  :5002  :5003  ...             │  │
                    │  └──────────────────────────────────────┘  │
                    │                                            │
                    │  ┌─────────────┐                           │
                    │  │  FIRESTORE  │  ibkr_accounts,             │
                    │  │  (managed)  │  ibkr_connections,          │
                    │  │             │  ibkr_api_keys              │
                    │  └─────────────┘                           │
                    └──────────────────────────────────────────┘

  Human onboarding/console (separate UI):
    Browser ──HTTPS──▶ Console (Next.js, same VM, /console path)
                       │  Firebase Auth (Google sign-in)
                       │  writes credentials → Secret Manager
                       │  issues API keys → Firestore
                       ▼
```

### Components

**Proxy** — public-facing. Authenticates API keys, resolves key → connection →
live Gateway port, forwards the request, returns the response. Stateless beyond
an in-memory cache it can rebuild.

**Supervisor** — internal. Owns the Gateway process lifecycle: spawn, port
allocation, health probing, keep-alive (tickle), re-auth, teardown. Exposes an
internal control API (`/connect`, `/status`, `/disconnect`) to the proxy.

**Gateway pool** — N Client Portal Gateway processes (wrapped, IBeam-style),
each bound to a distinct localhost port, each holding one IBKR account's
session.

**Datastore (Firestore, Native mode)** — persistent account-level state only:
who the users are, their API keys, which IBKR account each connection targets.
**Not** session state — see §5. Firestore is chosen over a relational DB
because the data model has no real joins; collections are prefixed `ibkr_` to
namespace within a shared GCP project.

**Firebase Auth** — human sign-in for the onboarding/console UI (Google
provider). A signed-in user maps 1:1 to an `ibkr_accounts` document via
`firebase_uid`. Firebase Auth is *not* used for the trading API surface —
machine clients authenticate with bearer API keys (§8).

> **Build note:** Proxy and Supervisor may ship as one process in v1 (two
> modules, one binary) to avoid an internal network hop. Keep them as separate
> modules with a clean interface so they can split later when the system goes
> multi-VM (§9).

---

## 5. State model — what is persisted vs. discovered

This distinction is central. Get it wrong and restarts corrupt or orphan
sessions.

| State | Lives in | Why |
|---|---|---|
| Users / accounts | Firestore | Application data; the OS cannot reproduce it. |
| API keys (hashed) | Firestore | Application data; must survive everything. |
| IBKR account id per connection | Firestore | Application data. |
| IBKR credentials | Secret Manager (ref in Firestore) | Application data; §6.1. |
| Credential health (`valid`/`rejected`) | Firestore | Fact about the credential, not a session. |
| Which Gateway process is on which port | **Discovered at runtime** | Observable by scanning processes. |
| Session authenticated? | **Discovered at runtime** | Probe the Gateway's `/auth/status`. |
| Last tickle time | In-memory (Supervisor) | Ephemeral; rebuilt by probing. |

**Rule:** session state is *never* written to Firestore. On Supervisor start,
it scans for running Gateway processes, probes each, and rebuilds its in-memory
map. A proxy/supervisor crash therefore loses nothing important — it
re-discovers. A full VM restart loses the processes themselves; all sessions
must re-authenticate (acceptable, named explicitly in §9).

The one thing the OS *cannot* hand back is **api-key → IBKR-connection** — that
is the operator's own mapping and must come from Firestore.

---

## 6. Data model (Firestore)

Written for **Model A** (operator-stored credentials, §2.1), the
**one-connection-per-API-key** API shape (§8), and **Firebase Auth** for
humans (§4). Credentials themselves live in GCP Secret Manager, never in
Firestore — see §6.1.

Three top-level collections. The `ibkr_` prefix namespaces this system within a
shared GCP project. Document ids are auto-generated UUIDs unless noted.

### `ibkr_accounts/{accountId}`

A platform user (your tenant). Created on first successful Firebase Auth
sign-in.

| Field | Type | Notes |
|---|---|---|
| `firebase_uid` | string | Unique. The Firebase Auth UID. Used as the lookup key on sign-in. |
| `email` | string | From the Google identity. |
| `display_name` | string \| null | From the Google identity. |
| `created_at` | timestamp | Server timestamp on first sign-in. |
| `status` | string | `active` \| `suspended`. |

Index: single-field index on `firebase_uid` (Firestore auto-indexes single
fields, but we depend on it being unique — enforced in code on account
creation).

### `ibkr_connections/{connectionId}`

One document per linked IBKR account.

| Field | Type | Notes |
|---|---|---|
| `account_id` | string | FK to `ibkr_accounts/{accountId}`. |
| `ibkr_account_id` | string \| null | e.g. `"U1234567"`. May be null until the first successful login resolves it. |
| `label` | string \| null | Human label for the connection. |
| `created_at` | timestamp | Server timestamp. |
| `ibkr_credential_ref` | string | Secret Manager resource name, e.g. `projects/auto-trader-493814/secrets/ibkr-conn-<uuid>`. **Never** the credential itself. See §6.1. |
| `credential_status` | string | `unknown` \| `valid` \| `rejected`. Persisted because it's a fact about the credential, not a session. |
| `credential_checked_at` | timestamp \| null | When `credential_status` was last updated. |

Indexes:
- composite (`account_id` ASC, `created_at` DESC) — list a user's connections.
- single-field on `account_id` — implicit.

### `ibkr_api_keys/{apiKeyId}`

One document per API key. **One key targets exactly one IBKR connection** (§8).
Store only a hash of the raw key; the raw value is shown once at creation.

| Field | Type | Notes |
|---|---|---|
| `ibkr_connection_id` | string | FK to `ibkr_connections/{connectionId}`. |
| `key_hash` | string | SHA-256 of the raw key, base64. |
| `key_prefix` | string | First 8 chars of the raw key, for cheap lookup and display. |
| `label` | string \| null | Human label. |
| `created_at` | timestamp | Server timestamp. |
| `last_used_at` | timestamp \| null | Bumped on every successful auth. |
| `revoked_at` | timestamp \| null | If set, the key is dead. |

Indexes:
- single-field on `key_prefix` — hot path on every API request.
- composite (`ibkr_connection_id` ASC, `created_at` DESC) — list keys for a
  connection in the console.

Lookup flow on a request: `key_prefix` → candidate docs (usually one) →
constant-time compare the full key against `key_hash` → if match and
`revoked_at == null`, resolve `ibkr_connection_id` → route.

### Notes

- **No `port`, no `session_status`, no `pid` fields.** Those are runtime state
  (§5) and must not be persisted.
- `ibkr_credential_ref` is a *pointer*. Reading the document tells you nothing
  exploitable; an attacker still needs Secret Manager IAM access to get the
  credential. This is deliberate — see §6.1.
- `credential_status` is the *only* session-adjacent field that is persisted,
  and it is justified: it is a fact about the stored credential (does IBKR
  still accept it?), not about a live session. It lets onboarding/UX tell a
  user "your IBKR password is stale" without a spawn attempt.
- **Firestore Security Rules.** All three collections are written/read **only**
  by the service's GCP service account (server SDK), never by clients
  directly. The console UI calls the proxy/onboarding backend; the backend
  validates the Firebase ID token and performs Firestore writes on the user's
  behalf. Rules should deny all client access by default.

### 6.1 Credential handling (Model A) — security-critical

The credentials are the highest-value asset in the system. This section is
normative, not advisory.

**Storage.**
- Each connection's IBKR credentials (username + password) are stored as a
  single secret in **GCP Secret Manager**, one secret per `ibkr_connection`.
- Postgres stores only `ibkr_credential_ref` — the secret's resource name.
- Credentials are **never** written to Postgres, never to disk on the VM, never
  to logs, never to error messages, never to crash dumps.

**Access.**
- Only the service's GCP service account may read these secrets (tight IAM;
  one role, least privilege).
- The service fetches a credential **only at spawn / re-auth time**, holds the
  plaintext **in memory only for the duration of the Gateway login**, and drops
  the reference immediately after. It is never retained in the Supervisor's
  long-lived in-memory state.

**Process surface.**
- The production container ships with **no shell** and minimal tooling — the
  plaintext credential transits process memory during login, so reduce who/what
  can inspect that process.
- Logging the credential — even at debug level, even partially — is forbidden.
  The build should include a test that asserts credentials never appear in log
  output.

**Rotation.**
- IBKR forces periodic password changes. When a user changes their IBKR
  password, the operator updates the Secret Manager secret value; the
  `ibkr_credential_ref` and the table row do not change.
- When a spawn/re-auth fails with an auth rejection, set
  `credential_status = 'rejected'` and stop retrying — retrying a wrong
  password risks locking the IBKR account. Surface a clear "update your IBKR
  credentials" error. On a successful login, set `credential_status = 'valid'`.

**Deletion / offboarding.**
- Removing a connection (or an account) must **destroy the Secret Manager
  secret**, not merely delete the Postgres row. Offboarding that leaves
  credentials in Secret Manager is a defect.

**2FA.** Every stored credential must be for a 2FA-free IBKR username — headless
injection cannot answer a 2FA push. This is enforced at onboarding (§9.1).

---

## 7. The connection lifecycle

### 7.1 `/connect` — idempotent, the heart of the system

`/connect` is **optional**: trading endpoints (§8) auto-invoke this same flow
when called against a cold session. Clients may call it explicitly as a
warm-up before a latency-sensitive workload (e.g. before market open).

When a connect request (explicit or implicit) arrives for an IBKR connection:

```
1. Acquire a per-connection lock (in-process mutex keyed by ibkr_connection_id).
   -> prevents the double-spawn race when two requests arrive together.

2. Is there a Gateway process already mapped to this connection?
   2a. No  -> go to step 4 (spawn).
   2b. Yes -> probe it (step 3).

3. Probe the existing process at its port:
      GET https://localhost:PORT/v1/api/iserver/auth/status
   - Process dead / port closed         -> reap it, go to step 4 (spawn).
   - Alive but authenticated == false   -> attempt re-auth; if it fails,
                                           reap and go to step 4.
   - Alive and authenticated == true    -> return { status: "ready", port }.

4. Spawn a new Gateway process:
   - Allocate a free port from the configured range.
   - Start the wrapped CP Gateway bound to that port.
   - Fetch the credential from Secret Manager via ibkr_credential_ref.
   - Inject the credential into the Gateway login; wait for
     authenticated == true (with a timeout).
   - Drop the plaintext credential from memory immediately.
   - On success: set credential_status = 'valid'.
   - On auth rejection: set credential_status = 'rejected', reap the process,
     do NOT retry (avoid locking the IBKR account), return an error telling the
     user to update their IBKR credentials.

5. Register the process in the Supervisor's in-memory map
   (connection_id -> { pid, port }) and release the lock.
```

`/connect` is **synchronous** under Model A: spawn → inject → wait for
`authenticated` → return `ready`. There is no human-in-the-loop branch. If the
login wait is long enough to be awkward for the caller, `/connect` returns
`202 connecting` and the caller polls `/status` — but the work is still fully
automated, no browser, no user.

**Implicit-connect behaviour for trading endpoints.** A trading endpoint
arriving against a cold or `degraded` session runs the §7.1 flow inline and
then serves the request. If the spawn would exceed a configured deadline
(e.g. 5s) the endpoint returns `202 connecting` with a hint to poll `/status`;
otherwise it blocks and returns the trading result normally.

**Critical:** the health probe in step 3 must hit the **auth-status endpoint**,
not just do a TCP connect. A process can be alive with its port open but the
session dead — a TCP check would pass it and you would route a trade into a
dead session and get a 401.

### 7.2 Keep-alive & self-healing

The Supervisor runs a background loop, independent of request traffic. For each
live session, every ~30 seconds: call the Gateway's `tickle` endpoint.

If a session reports unauthenticated, mark it `degraded` and **self-heal**: the
re-auth path reuses the §7.1 step-4 logic — re-fetch the credential, re-inject,
wait for `authenticated == true`. This is Model A's main payoff: a session that
drops overnight is restored with no human involvement, in time for a scheduled
workload. While a connection is `degraded` and mid-heal, the proxy returns
`503` for it (or `202 connecting` if the implicit-connect path is active).

If re-auth fails with an auth rejection, set `credential_status = 'rejected'`,
stop retrying, and leave the connection `disconnected` until the user updates
their credentials. Do not loop on a rejected credential — that risks locking
the IBKR account.

Do **not** put keep-alive in the request path.

### 7.3 Teardown

`/disconnect` reaps the process and frees the port. Also reap on: process death
detected by the keep-alive loop, account suspension, or API-key revocation
leaving a connection with no active keys (policy decision — confirm).

---

## 8. Public API (proxy)

All requests authenticated with `Authorization: Bearer <api_key>`. The proxy
resolves `key → connection` directly (1:1, §6) and forwards to the matching
Gateway. **No connection id appears in the path.**

### Control

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/connect` | Optional warm-up. Idempotent (§7.1). Returns `ready`, or `202 connecting`, or an error if `credential_status = rejected`. |
| GET  | `/v1/status` | Session state: `ready` / `connecting` / `degraded` / `disconnected` / `credential_rejected`. |
| POST | `/v1/disconnect` | Reap the session. |

### Trading & portfolio (thin passthrough to the Gateway)

Each of these **auto-connects** if the session is cold (§7.1). Clients do not
need to call `/v1/connect` first.

| Method | Path | Maps to IBKR Web API |
|---|---|---|
| GET  | `/v1/positions` | `/portfolio/accounts` then `/portfolio/{acct}/positions/{page}` |
| GET  | `/v1/cash`      | `/portfolio/{acct}/ledger` (per-currency cash balances) |
| POST | `/v1/orders`    | `/iserver/account/{acct}/orders` |
| GET  | `/v1/orders`    | `/iserver/account/orders` (live orders) |
| GET  | `/v1/orders/{orderId}` | `/iserver/account/order/status/{orderId}` |
| DELETE | `/v1/orders/{orderId}` | `/iserver/account/{acct}/order/{orderId}` |

### IBKR quirks the passthrough must absorb

These are real behaviours of the IBKR Web API. The proxy should hide them so
callers get clean semantics.

- **Order placement reply flow.** Placing an order frequently returns a
  *confirmation prompt* (margin warning, price cap, size warning) with a reply
  id, not an immediate fill. The proxy must either (a) auto-reply to known-safe
  confirmations and surface the rest, or (b) expose the reply id and a
  `/orders/{id}/reply` endpoint. **Decide which.** Auto-replying to everything
  is dangerous; surfacing everything is tedious. Recommended: auto-reply to a
  small allowlist of benign confirmations, surface anything else.
- **Two-call live-orders endpoint.** The live-orders endpoint often must be
  called twice — the first call primes, the second returns data. The proxy
  should do both internally and return the populated result.
- **`/portfolio/accounts` precedion.** `/portfolio/accounts` must be called
  once before other `/portfolio` calls in a session. The proxy should do this
  lazily on first portfolio request per session and cache the account id.
- **Order ids are per-session.** Order/status correlation uses IBKR's order id;
  do not assume it is stable across a session restart.

---

## 9. Failure modes & operational reality

| Failure | Effect | Handling |
|---|---|---|
| Proxy/Supervisor crash | None to sessions | Restart; re-discover processes (§5). |
| Single Gateway wedges | One connection down | Keep-alive marks `degraded`; reap + respill. |
| **VM restart / loss** | **All sessions down** | All connections re-authenticate. v1 accepts this. |
| Double `/connect` race | Two processes, IBKR rejects 2nd | Per-connection lock (§7.1) prevents it. |
| IBKR backend outage | All calls fail | Surface `502/503`; do not hammer; back off. |
| Port exhaustion | Spawn fails | Cap max concurrent processes; return `503` + clear error. |
| 2FA on an account | Headless login hangs | Onboarding precondition — see §9.1. |
| Stale IBKR password | Spawn/re-auth rejected | Set `credential_status=rejected`, stop retrying, prompt user (§6.1). |

### 9.1 Two-factor authentication — hard onboarding requirement

Headless credential injection cannot answer an interactive IBKR Mobile 2FA
push. Under Model A there is no human at login time. Therefore:

**Every IBKR username connected to this system must be 2FA-free.** This is a
precondition enforced at onboarding, not a runtime concern.

In practice, instruct each user to create a **dedicated secondary IBKR
username** for API use, without IBKR Mobile 2FA enabled. IBKR supports
secondary usernames precisely so that one product/session does not lock out
another — and this also keeps the user's primary (2FA-protected) login intact
for their phone app while the bot uses the secondary one.

Failure mode if skipped: a 2FA-enabled credential causes the spawn to hang at
login until timeout. This will *look* like a session bug but is actually an
onboarding failure. The onboarding flow should make the 2FA-free requirement
explicit and, ideally, the first successful `/connect` validates it.

**Detection & remediation.** When the spawn login times out without reaching
`authenticated == true`, the system reaps the Java process and returns
`TwoFactorRequiredError` (`src/errors.ts`). The error payload includes
`remediation` — concrete step-by-step instructions for creating a 2FA-free
secondary username in IBKR Client Portal. The error is intentionally
distinguishable from `CredentialRejectedError` so the operator can tell
"wrong password" from "username has 2FA" at a glance.

Both errors are also safe to display verbatim in the console UI; they
contain no credential material.

### 9.2 Single-VM is a single point of failure

Every session lives on one box. A zone outage takes out all users at once. This
is an accepted v1 limitation. The mitigation is §9.3, not heroics in v1.

### 9.3 Path to multi-VM (post-v1)

When ready to scale out: the Supervisor becomes one-per-VM; the proxy needs to
know *which VM* hosts a given connection. That is the one piece of routing state
worth persisting (a `host` column, or a small shared registry like Redis).
Until then, `host` is implicitly "the only VM" and stays out of the schema.

---

## 10. Rejected & deferred alternatives

Recorded so they are not re-litigated mid-build.

- **OAuth 2.0 token model (no Gateway at all).** This is the *right* end state —
  no processes, no credential custody, serverless-friendly. **Rejected for v1
  because IBKR does not currently grant OAuth to retail accounts** ("under
  consideration, no ETA"). Re-evaluate periodically; if it opens, §7's spawn
  logic is replaced by a token store, the Secret Manager credential store
  disappears, and most of the Supervisor disappears with it.
- **Model B — user self-login, no stored credentials.** Lower custody risk and
  no 2FA problem. **Rejected because it cannot support unattended operation:**
  a session that dies outside working hours cannot be restored until a human
  logs in via browser, which blocks the scheduled autonomous trading workload
  that is this system's primary purpose. Model A's credential custody is
  accepted instead, on the basis of a closed user group with signed terms
  (§2.1) and the §6.1 mitigations.
- **TWS API / socket transport.** More mature and event-driven (push order
  status vs. polling). Rejected because it does not solve multi-tenancy — still
  one heavyweight IB Gateway process per account — and adds an always-on
  stateful socket service and a Java GUI app per tenant. CP Gateway is lighter
  and HTTP-native.
- **Registered Advisor / Introducing Broker program.** IBKR's *sanctioned*
  multi-tenant path (the Account Management API, white-branded, real
  account-linking). Deferred: it is a business/compliance decision, not an
  engineering task. It is the correct long-term answer if this becomes a real
  product with external users.
- **N static pre-provisioned containers.** The common community pattern. Works
  but does not scale to dynamic user signup; the dynamic `/connect` supervisor
  (§7.1) is the chosen approach.
- **Connection id in the API path (e.g. `/v1/connections/{id}/positions`).**
  Considered, then **rejected**: with API keys scoped 1:1 to a connection
  (§6), the id is redundant — the key already identifies the target. Dropped
  in favour of the flatter `/v1/positions`, `/v1/orders`, … shape.
- **Postgres for the datastore.** The original draft used a relational schema.
  **Replaced with Firestore** (§6) because the data model has no real joins
  (just FK-style lookups), Firestore is serverless and pairs naturally with
  Firebase Auth on the console, and there's no DB instance to manage. If
  query needs ever grow beyond what Firestore handles well (analytics,
  ad-hoc joins), revisit.

---

## 11. Build order for Claude Code

A suggested sequence — each step independently testable.

1. **Firestore schema + seed.** Collections from §6 (`ibkr_accounts`,
   `ibkr_connections`, `ibkr_api_keys`); composite indexes declared in
   `firestore.indexes.json`. Deny-by-default Firestore Security Rules. Seed
   one test account, one connection, one API key for the integration tests.
2. **Secret Manager integration.** Wire up GCP Secret Manager: create/read/
   update/destroy a credential secret for a connection; store the ref in
   `ibkr_connections`. Verify IAM is least-privilege. Build the no-logging
   assertion test (§6.1) early so it guards everything after.
3. **Gateway wrapper.** Get one CP Gateway running headless on a fixed port
   with credentials injected from Secret Manager; confirm `auth/status`,
   `positions`, `ledger` calls work end to end against a paper account. This
   de-risks everything else.
4. **Supervisor — spawn & probe.** `/connect` for a single hardcoded
   connection: spawn, allocate port, fetch+inject credential, auth-aware health
   probe, in-memory map, `credential_status` updates.
5. **Supervisor — keep-alive & self-healing.** Background tickle loop;
   `degraded` detection; credential re-injection on drop; rejection handling;
   teardown; restart-rediscovery (§5).
6. **Per-connection spawn lock** (§7.1). Test with concurrent `/connect` calls.
7. **Proxy — auth.** API-key Bearer auth: prefix lookup + hash verify;
   `last_used_at` update; revocation honored; key → connection resolution.
8. **Proxy — passthrough.** The §8 endpoints (no `{id}` in paths), including
   the IBKR quirk handling (reply flow, two-call orders, `/portfolio/accounts`
   priming) and the implicit-connect behaviour on trading endpoints.
9. **Hardening.** Port-exhaustion cap, backoff on IBKR outage, structured
   logging per connection (credential-free), `/disconnect`, offboarding that
   destroys the Secret Manager secret.

### Testing

- Use an IBKR **paper trading** account throughout. Never test order placement
  against a live account.
- Simulate session loss by killing a Gateway process and asserting the
  keep-alive loop marks it `degraded` and the next trading call (or explicit
  `/connect`) respawns it.
- Simulate proxy restart and assert sessions are re-discovered, not orphaned.

---

## 12. Open decisions (resolve before / during build)

1. ~~Credential model A vs. B~~ — **RESOLVED: Model A** (§2.1). Schema in §6 is
   final.
2. ~~API shape: connection id in path vs. inferred from key~~ — **RESOLVED:
   one API key per IBKR connection; no `{id}` in paths** (§6, §8).
3. ~~Explicit vs. implicit connect~~ — **RESOLVED: implicit on trading
   endpoints; `/v1/connect` remains as an optional warm-up** (§7.1, §8).
4. **Order confirmation policy** (§8) — auto-reply allowlist vs. surface all.
5. **API-key revocation → connection teardown** — does revoking the last key
   on a connection reap the session? (Recommended: yes, after a grace period.)
6. **Terms of use** (§2.1) — draft the written terms users sign: acknowledges
   voluntary credential provision, operator storage, 2FA-free secondary
   username requirement, and risk acceptance. Closed group (operator +
   acquaintances) is the stated basis; if the group broadens, the MiFID II
   custody question must be revisited with qualified advice.
7. ~~Onboarding flow for credential capture~~ — **RESOLVED:** Next.js console
   at `/console`, gated by **Firebase Auth** (Google sign-in). The console
   calls a backend endpoint that validates the Firebase ID token and writes
   the IBKR credentials **straight to Secret Manager**; the raw credential
   never touches a log or Firestore. The console also issues/revokes API keys
   and displays connection status (§8 `/v1/status`).
