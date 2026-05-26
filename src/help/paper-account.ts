// /help/paper-account — explains IBKR's paper-trading accounts and
// how to enable one. Public, no auth required.
//
// Information sourced from IBKR's published docs, the application
// flow we walked through on our own paper account (DUQ443672, May
// 2026), and the live debugging of the CLI sign-in path.

import { renderHelpPage } from "./layout.js";

export function paperAccountHtml(): string {
  return renderHelpPage({
    title: "IBKR Paper Accounts",
    bodyHtml: `
<h1>Paper accounts on Interactive Brokers</h1>

<p>
  A <strong>paper trading account</strong> at Interactive Brokers is a
  fully-simulated copy of the live trading environment. You can place
  orders, hold positions, see market data (delayed by default), and
  watch P&amp;L move — but no real money or shares change hands. Paper
  accounts are the only safe place to develop and test code that
  talks to the IBKR Web API, and the recommended first connection
  to wire into this gateway.
</p>

<div class="note">
  IBKR Gateway recommends that your <strong>first</strong> connection
  point at a paper username. Live accounts have additional
  prerequisites (the
  <a href="/help/authenticator-app">Authenticator App</a> for unattended
  re-auth) and any mistake there moves real money.
</div>

<h2>What you get</h2>
<ul>
  <li>
    <strong>USD 1,000,000 of simulated cash</strong>, refreshed
    automatically at the start of each month if your balance has
    drifted away from it.
  </li>
  <li>
    Full access to the IBKR Client Portal Web API — every endpoint a
    live account uses (<code>/portfolio</code>, <code>/iserver/account/orders</code>,
    <code>/iserver/marketdata/snapshot</code>, etc.).
  </li>
  <li>
    Delayed market data on most US equities, options, and futures
    out of the box. Real-time subscriptions on a paper account are
    mirrored from your live account's subscriptions.
  </li>
  <li>
    A separate username and account ID (e.g.&nbsp;<code>wawpkp283</code>
    /&nbsp;<code>DUQ443672</code>); your live login does <em>not</em>
    grant paper access.
  </li>
</ul>

<h2>What you don't get</h2>
<ul>
  <li>
    Real-time market data unless your live account has the
    subscriptions enabled. Without them, snapshot prices may show as
    blank — historical bars from <code>/iserver/marketdata/history</code>
    still work and so do day/week/month/year change calculations.
  </li>
  <li>
    Fills that exactly reflect live liquidity. The paper engine
    assumes ample size at the displayed price; thinly-traded symbols
    can fill in paper but not in reality.
  </li>
  <li>
    Most fees and margin interest (the simulation models a simplified
    version).
  </li>
</ul>

<hr />

<h2>How to enable a paper account on IBKR</h2>

<div class="card steps">
  <div class="step">
    Have a <strong>live IBKR account that has been approved and
    funded</strong>. Paper trading is not offered standalone — IBKR
    requires an active brokerage relationship first. If your live
    application is still in any pending state, finish that first.
  </div>

  <div class="step">
    Log into Client Portal at
    <a href="https://www.interactivebrokers.com/sso/Login" target="_blank" rel="noopener">
    interactivebrokers.com</a> with your live credentials.
  </div>

  <div class="step">
    Top-right menu (head &amp; shoulders icon) → <strong>Settings</strong>.
    In the search box on the left, type <em>paper</em>.
  </div>

  <div class="step">
    Click <strong>Paper Trading Account</strong> under "Account
    Configuration". On the next screen, click <strong>Yes</strong>
    next to "Would you like a Paper Trading Account?". Accept the
    terms and submit.
  </div>

  <div class="step">
    IBKR shows a confirmation page with your new
    <strong>paper username</strong> (e.g.&nbsp;<code>wawpkp283</code>)
    and <strong>paper account ID</strong> (e.g.&nbsp;<code>DUQ443672</code>).
    <em>Write these down</em> — you will not see the username again
    in the live portal and IBKR will not email it to you.
  </div>
</div>

<div class="note">
  <strong>The paper username is independent of your live login.</strong>
  IBKR generates a random one (you don't get to pick it). The first
  password is the <em>same as your live password</em> at the moment
  of creation, but the two are decoupled afterwards — changing one
  does not change the other. We strongly recommend setting a unique
  password on the paper account once it's active.
</div>

<h2>The approval wait</h2>

<div class="card">
  <p>The screen you see right after submitting reads roughly:</p>
  <p style="color: var(--muted); padding-left: 16px; border-left: 2px solid var(--border);">
    Your Paper Trading Account application has been submitted, and if
    received by 4 PM (Eastern Time) on any normal business day will
    be processed by the next business day under normal circumstances
    (provided your normal trading account is approved and funded).
  </p>
  <p>In practice the timing is one of:</p>
  <ul>
    <li>
      <strong>Same business day, a few hours</strong> — typical when
      you submit before noon ET on a US trading day. Paper accounts
      usually flip from <em>pending</em> to <em>active</em> somewhere
      between 1 and 4 hours after submission.
    </li>
    <li>
      <strong>Next business day</strong> — when you submit after
      4&nbsp;PM ET, on a Friday evening, weekend, or US holiday.
    </li>
    <li>
      <strong>Longer (24–72 hours)</strong> — if your live account
      application is still in any "in review" state. The paper
      approval cannot complete until the live application is final.
    </li>
  </ul>
  <p class="muted">
    There is no notification email. You re-check by trying to log in
    with the paper username — you'll either land in the portal or
    see the "application in progress" page until it flips.
  </p>
</div>

<h2>How to tell it's active</h2>
<p>Two signals work, in order of reliability:</p>
<ol>
  <li>
    On the IBKR Client Portal, <strong>flip the Live/Paper toggle</strong>
    to Paper and log in with the paper username. If you land on the
    portal dashboard (showing $1,000,000 USD in cash), the account
    is active.
  </li>
  <li>
    Via this CLI, see the section below — a successful sign-in that
    shows <em>"brokerage: authenticated=true connected=true"</em> and
    a non-empty cash ledger means you're in.
  </li>
</ol>

<div class="ok">
  <strong>Once active, the paper account never expires</strong> while
  your live account remains in good standing. You only need to enable
  it once.
</div>

<hr />

<h2>Using your paper account with this gateway</h2>

<h3>From the CLI</h3>

<p>
  Run <code>node cli/ibkr.js</code> and pick <strong>paper</strong>:
</p>
<div class="card" style="font-family: ui-monospace, monospace; white-space: pre;">── Sign in ──
Mode [paper/live] (default 'live'): paper
Username: <i>your paper username</i>
Password: ********
Open browser visibly (debugging only)? [y/N]
  · launching chromium…
✓ signed in as wawpkp283 (mode=paper)
  brokerage: authenticated=true connected=true</div>
<p>
  No 2FA, no Authenticator-App secret — paper accounts can't have
  either. State is persisted to <code>~/.ibkr-cli/session.json</code>
  so subsequent runs just say "Existing session — reuse? [Y/n]" and
  go straight to the menu.
</p>

<h3>From the web console</h3>

<p>
  Sign in to the <a href="/console">console</a> with your Google
  account. Create a new connection, choose mode <strong>Paper</strong>,
  and enter the paper username + password. The web service handles
  re-auth automatically (paper sessions are simpler than live —
  there's nothing to maintain beyond the cookies).
</p>

<p>
  Once the connection is created, the gateway issues you a per-connection
  bearer key. Calls to <code>/v1/api/*</code> on the gateway are
  proxied straight to your paper IBKR session.
</p>

<hr />

<p class="muted">
  Last verified against IBKR's portal in May 2026. If the menu has
  shifted, the canonical URL for the enable form is
  <a href="https://www.interactivebrokers.com/sso/Login?action=PAPER_TRADER" target="_blank" rel="noopener">
  interactivebrokers.com/sso/Login?action=PAPER_TRADER</a>.
</p>
`,
  });
}
