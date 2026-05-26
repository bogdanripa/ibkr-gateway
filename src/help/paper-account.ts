// /help/paper-account — explains IBKR's paper-trading accounts and
// how to enable one. Public, no auth required.
//
// Information sourced from IBKR's published docs:
//   · https://www.interactivebrokers.com/en/trading/papertrader.php
//   · IBKR Knowledge Base: "How to obtain a Paper Trading Account"
//     (article ref IBKB-1004 / current URL changes occasionally)
//   · Direct observation of the application flow on our own paper
//     account (DUQ443672, May 2026 — see SPEC §2).

import { renderHelpPage } from "./layout.js";

export function paperAccountHtml(): string {
  return renderHelpPage({
    title: "IBKR Paper Accounts",
    bodyHtml: `
<h1>Paper accounts on Interactive Brokers</h1>

<p>
  A <strong>paper trading account</strong> at Interactive Brokers is a
  fully-simulated copy of the live trading environment. You can place
  orders, hold positions, see real market data (delayed by default),
  and watch P&amp;L move — but no real money or shares change hands.
  Paper accounts are the only safe place to develop and test code
  that talks to the IBKR Web API.
</p>

<div class="note">
  IBKR Gateway requires a paper account to onboard. The first
  connection you create here must point at a paper username; placing
  orders against a live account is a separate, deliberate step.
</div>

<h2>What you get</h2>
<ul>
  <li><strong>USD 1,000,000 of simulated cash</strong>, refreshed
      automatically at the start of each month if your balance has
      drifted away from it.</li>
  <li>Full access to the IBKR Client Portal Web API, including
      <code>/portfolio</code>, <code>/iserver/account/orders</code>,
      <code>/iserver/marketdata/snapshot</code>, etc. — the same
      endpoints a live account uses.</li>
  <li>Delayed market data on most US equities, options, and futures
      out of the box. Real-time data subscriptions on a paper
      account are mirrored from your live account's subscriptions.</li>
  <li>A separate username and account ID
      (e.g. <code>wawpkp283</code> / <code>DUQ443672</code>); your
      live login does <em>not</em> grant paper access.</li>
</ul>

<h2>What you don't get</h2>
<ul>
  <li>Real-time market data unless your funded live account has the
      subscriptions enabled. Without them, snapshot prices may show
      as blank — historical bars from
      <code>/iserver/marketdata/history</code> still work.</li>
  <li>Fills that exactly reflect live liquidity. The paper engine
      assumes ample size at the displayed price; thinly-traded
      symbols can fill in paper but not in reality.</li>
  <li>Most fees and margin interest (the simulation models a
      simplified version).</li>
</ul>

<hr />

<h2>How to enable a paper account</h2>

<div class="card steps">
  <div class="step">
    Have a <strong>live IBKR account that has been approved and
    funded</strong>. Paper trading is not offered standalone — IBKR
    requires an active brokerage relationship first. If your
    application is still pending review (status: "In Progress"),
    finish that first.
  </div>

  <div class="step">
    Log into Client Portal at
    <a href="https://www.interactivebrokers.com/sso/Login" target="_blank" rel="noopener">
    interactivebrokers.com</a> with your live credentials.
  </div>

  <div class="step">
    Open the user menu (top-right, head &amp; shoulders icon) →
    <strong>Settings</strong>. In the search box on the left, type
    <em>paper</em>.
  </div>

  <div class="step">
    Click <strong>Paper Trading Account</strong> under
    "Account Configuration". On the next screen, click
    <strong>Yes</strong> next to "Would you like a Paper Trading Account?".
    Accept the terms and submit.
  </div>

  <div class="step">
    IBKR shows a confirmation page with your new
    <strong>paper username</strong> (e.g. <code>wawpkp283</code>) and
    <strong>paper account ID</strong> (e.g. <code>DUQ443672</code>).
    <em>Write these down</em> — you will not see the username again
    in the live portal, and IBKR won't email it to you.
  </div>
</div>

<div class="note">
  <strong>The paper username is independent of your live login.</strong>
  IBKR generates a random one (you don't get to pick it). The first
  password is the <em>same as your live password</em> at the moment of
  creation, but the two are decoupled afterwards — changing one does
  not change the other. We strongly recommend setting a unique
  password on the paper account once it's active, especially if you
  will store it for headless automation.
</div>

<h2>The approval wait</h2>

<div class="card">
  <p>
    The screen you see right after submitting reads roughly:
  </p>
  <p style="color: var(--muted); padding-left: 16px; border-left: 2px solid var(--border);">
    Your Paper Trading Account application has been submitted, and if
    received by 4 PM (Eastern Time) on any normal business day will
    be processed by the next business day under normal circumstances
    (provided your normal trading account is approved and funded).
  </p>
  <p>
    In practice the timing is one of:
  </p>
  <ul>
    <li><strong>Same business day, a few hours</strong> — typical when
        you submit before noon ET on a US trading day. Paper accounts
        usually flip from <em>pending</em> to <em>active</em>
        somewhere between 1 and 4 hours after submission.</li>
    <li><strong>Next business day</strong> — when you submit after
        4 PM ET, or on a Friday evening / weekend / US holiday.</li>
    <li><strong>Longer (24–72 hours)</strong> — if your live account
        application is still in any "in review" state. The paper
        approval cannot complete until the live application is
        finalized.</li>
  </ul>
  <p class="muted">
    There is no notification email. You re-check by trying to log
    into <code>/sso/Login</code> with the paper username — you'll
    either get a successful session or the
    "application in progress" page until it flips.
  </p>
</div>

<h2>How to tell it's active</h2>
<p>Two signals work, in order of reliability:</p>
<ol>
  <li>
    On the IBKR Client Portal, <strong>flip the Live/Paper toggle</strong>
    to Paper and log in with the paper username. If you land on the
    portal dashboard (showing $1,000,000 USD in cash), the account is
    active.
  </li>
  <li>
    Via this CLI:
    <code>node cli/ibkr.js</code> → mode "paper" → username + password.
    A successful sign-in that shows
    <em>"brokerage: authenticated=true connected=true"</em> and a
    non-empty cash ledger means you're in.
  </li>
</ol>

<div class="ok">
  <strong>Once active, the paper account never expires</strong> while
  your live account remains in good standing. You only need to enable
  it once.
</div>

<h2>Connecting it to this gateway</h2>
<ol>
  <li>Sign in to the <a href="/console">console</a> with your Google
      account.</li>
  <li>Create a new connection. When prompted for the IBKR username
      and password, supply the <strong>paper</strong> credentials
      (not your live ones).</li>
  <li>For the mode, choose <strong>Paper</strong>. The gateway
      records this and uses it when starting the per-connection
      headless login session.</li>
</ol>

<p>
  Once the connection is established, the gateway issues you a
  per-connection bearer key you can use against
  <code>/v1/api/*</code> just like a direct IBKR session.
</p>

<hr />

<p class="muted">
  Last verified against IBKR's portal in May 2026. If IBKR has
  reshuffled the menu structure since, the canonical URL for the
  enable form is
  <a href="https://www.interactivebrokers.com/sso/Login?action=PAPER_TRADER" target="_blank" rel="noopener">
  interactivebrokers.com/sso/Login?action=PAPER_TRADER</a>.
</p>
`,
  });
}
