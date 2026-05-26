// /help/authenticator-app — explains IBKR's Authenticator App
// (standard TOTP / RFC 6238) and walks through enabling it so the
// gateway can re-auth a live account unattended. Public — no
// Firebase auth required.
//
// Verified against bripa123's real live enrollment on 2026-05-26.

import { renderHelpPage } from "./layout.js";

export function authenticatorAppHtml(): string {
  return renderHelpPage({
    title: "IBKR Authenticator App (TOTP)",
    bodyHtml: `
<h1>IBKR Authenticator App — for unattended live auth</h1>

<p>
  IBKR sessions die. They die <strong>multiple times during the
  trading day</strong> and at least once overnight when IBKR's
  servers roll connections. The gateway has to be able to bring the
  session back up by itself, which means it has to answer IBKR's
  two-factor challenge by itself — without a human tapping a phone
  at 3 AM. That's what <strong>IBKR's "Authenticator App"</strong>
  option is for, and it's <strong>mandatory</strong> on any live
  connection in this gateway.
</p>

<div class="note">
  Paper accounts cannot have 2FA enabled — this whole page only
  applies to live accounts. To set up a paper account first, see
  <a href="/help/paper-account">how paper accounts work</a>.
</div>

<h2>What "Authenticator App" actually is</h2>
<p>
  IBKR's name for <strong>standard TOTP</strong> (RFC 6238). The same
  protocol Google Authenticator, Authy, 1Password, Yubico
  Authenticator and others implement. When you enroll, IBKR shows
  you:
</p>
<ul>
  <li>a <strong>QR code</strong> for scanning into a phone app, and</li>
  <li>an <strong>Activation Code</strong> — the same secret in
      human-readable base32 form (a string of letters A–Z and digits
      2–7, typically 16–32 characters).</li>
</ul>
<p>
  That activation code is the only thing the gateway needs. With it
  plus the current UTC time, anyone (or any program) can compute the
  6-digit code IBKR expects at login. No phone, no app, no human.
  Your phone authenticator and this gateway both hold the same
  secret and produce the same code independently.
</p>

<hr />

<h2>How to enable Authenticator App on IBKR</h2>

<div class="card steps">
  <div class="step">
    Log into Client Portal at
    <a href="https://www.interactivebrokers.com/sso/Login" target="_blank" rel="noopener">
    interactivebrokers.com</a> with your live credentials.
  </div>

  <div class="step">
    Top-right menu (head &amp; shoulders icon) →
    <strong>Settings</strong>. In the search box on the left, type
    <em>secure login</em>, then click <strong>Secure Login System</strong>.
  </div>

  <div class="step">
    Click <strong>Add a Second Factor</strong> → choose
    <strong>Authenticator App</strong> (sometimes labelled "Soft
    Token" or "Mobile Authenticator App" depending on region).
  </div>

  <div class="step">
    IBKR shows a QR code with the <strong>Activation Code</strong>
    printed underneath.
    <strong>⚠ Copy the Activation Code right now</strong>, before
    doing anything else. IBKR hides it once you click Continue and
    there's no "show again" button — only re-enrollment if you lose
    it. Treat it like a password.
  </div>

  <div class="step">
    <strong>Also scan the QR with a real authenticator app</strong>
    on your phone (Google Authenticator, Authy, 1Password, Yubico
    Authenticator — any of them). This is your manual fallback if
    the activation code ever gets lost or revoked from the gateway.
  </div>

  <div class="step">
    Click <strong>Continue</strong>. IBKR asks you to type the
    current 6-digit code from your authenticator app to prove
    enrollment succeeded. Type it; the method is now enrolled.
  </div>
</div>

<div class="ok">
  <strong>Keep IB Key (or another second factor) enrolled too.</strong>
  Don't make Authenticator App your only method. If you lose the
  activation code and the gateway loses it too, you'd need IBKR's
  account-recovery process, which can take days.
</div>

<h2>Verifying it works</h2>
<ol>
  <li>Log out of IBKR Client Portal completely.</li>
  <li>
    Log back in with your live username + password. After
    submitting, IBKR shows a <strong>"Select Second Factor
    Device"</strong> page (because you now have both IB Key and
    Mobile Authenticator App enrolled).
  </li>
  <li>
    Pick <strong>Mobile Authenticator App</strong>; type the current
    6-digit code from your phone app; you should land in the portal.
  </li>
</ol>

<hr />

<h2>Using your live account with this gateway</h2>

<h3>From the CLI</h3>

<p>
  Run <code>node cli/ibkr.js</code> and pick <strong>live</strong>:
</p>
<div class="card" style="font-family: ui-monospace, monospace; white-space: pre;">── Sign in ──
Mode [paper/live] (default 'live'): live
Username: <i>your live username</i>
Password: *************

  Live accounts must have IBKR's "Authenticator App" 2FA enabled.
  Paste the activation code (base32 secret) IBKR showed you when
  you enrolled. Not the 6-digit code — the secret.
Activation code: ********************************
  · launching chromium…
  · selecting "Mobile Authenticator App" (value=4)
  · generating TOTP code
  · filling TOTP code
✓ signed in as <i>your-user</i> (mode=live)
  brokerage: authenticated=true connected=true</div>
<p>
  The activation code is saved to
  <code>~/.ibkr-cli/session.json</code> (file mode 0600). Every
  subsequent run is silent — the CLI re-derives the current 6-digit
  TOTP from the stored secret, fills it in, and you're back in
  without ever touching your phone.
</p>

<h3>From the web console</h3>

<p>
  Sign in to the <a href="/console">console</a> with your Google
  account. Create a new connection, choose mode
  <strong>Live</strong>. The connection form requires three fields:
</p>
<ul>
  <li><strong>Username</strong> — your live IBKR username.</li>
  <li><strong>Password</strong> — your live IBKR password.</li>
  <li>
    <strong>Activation Code</strong> — the base32 secret from
    enrollment above. <em>Required</em> for live mode; the form
    rejects submission without it.
  </li>
</ul>
<p>
  The activation code is stored in
  <a href="https://cloud.google.com/secret-manager" target="_blank" rel="noopener">
  GCP Secret Manager</a> — never plaintext in Firestore, never in
  logs. The gateway reads it each time IBKR drops the session and
  re-auths automatically. You can rotate or remove the secret from
  the connection page at any time.
</p>

<hr />

<h2>Security</h2>
<ul>
  <li>
    The activation code is <strong>at-rest credential material</strong>.
    Anyone with the file can log into your live account, indefinitely,
    until you re-enroll on IBKR.
  </li>
  <li>
    <strong>On the CLI</strong>: stored in
    <code>~/.ibkr-cli/session.json</code>, file mode 0600. Fine for
    a single user's laptop. Not fine if that laptop is shared or
    backed up to a public cloud / git repo / Time Machine
    destination you don't trust.
  </li>
  <li>
    <strong>On the gateway</strong>: stored in GCP Secret Manager.
    Access mediated by the service account; the value never appears
    in logs, in Firestore, or in API responses.
  </li>
  <li>
    <strong>If you suspect a leak:</strong> Client Portal → Settings →
    Secure Login System → remove Authenticator App → re-add. The old
    secret is invalidated immediately, and you'll get a new
    activation code to paste into the CLI / web console.
  </li>
</ul>

<h2>Rotating the activation code</h2>
<ol>
  <li>Remove Authenticator App in the IBKR portal.</li>
  <li>Add it again. Copy the new activation code.</li>
  <li>
    Update wherever you stored the old one:
    <ul>
      <li>
        <strong>CLI</strong>: re-run <code>node cli/ibkr.js</code>,
        choose live, paste the new activation code — it overwrites
        the old one in <code>session.json</code>.
      </li>
      <li>
        <strong>Web console</strong>: open the connection, click
        Rotate Activation Code, paste the new one. The gateway
        replaces the Secret Manager value and the next re-auth uses
        the new secret.
      </li>
    </ul>
  </li>
</ol>

<p class="muted">
  Last verified end-to-end against a real live IBKR account in
  May 2026. If IBKR has moved the menu, search for "secure login"
  or "two-factor" inside Account Settings.
</p>
`,
  });
}
