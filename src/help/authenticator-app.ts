// /help/authenticator-app — explains IBKR's Authenticator App
// (Authenticator App = standard TOTP / RFC 6238) and walks through
// enabling it so the gateway can re-auth a live account unattended.
// Public — no Firebase auth required.

import { renderHelpPage } from "./layout.js";

export function authenticatorAppHtml(): string {
  return renderHelpPage({
    title: "IBKR Authenticator App (TOTP)",
    bodyHtml: `
<h1>IBKR Authenticator App — for unattended live auth</h1>

<p>
  For a <strong>live</strong> IBKR account the gateway needs to bring
  the session back up by itself when IBKR drops it — and they do drop
  it, every few hours during the trading day and at least once
  overnight. With IB Key alone, that means a human tapping a phone in
  the middle of the night. With <strong>IBKR's "Authenticator App"</strong>
  option enabled the gateway can answer the 2FA challenge on its own.
</p>

<div class="note">
  Paper accounts cannot have 2FA enabled — this whole page only
  applies to live accounts. To set up a paper account first, see
  <a href="/help/paper-account">how paper accounts work</a>.
</div>

<h2>What "Authenticator App" actually is</h2>
<p>
  IBKR's name for <strong>standard TOTP</strong> (RFC 6238). The same
  protocol Google Authenticator, Authy, 1Password, Yubico Authenticator
  and others implement. When you enroll, IBKR shows you:
</p>
<ul>
  <li>a <strong>QR code</strong> for scanning into a phone app, and</li>
  <li>an <strong>Activation Code</strong> — the same secret in
      human-readable base32 form (a string of letters A-Z and digits
      2-7, typically 16-32 characters).</li>
</ul>
<p>
  That activation code is the only thing the gateway needs. With it
  plus the current UTC time, anyone (or any program) can compute the
  6-digit code IBKR expects at login. No phone, no app, no human.
</p>

<hr />

<h2>How to enable it on IBKR</h2>

<div class="card steps">
  <div class="step">
    Log into Client Portal at
    <a href="https://www.interactivebrokers.com/sso/Login" target="_blank" rel="noopener">
    interactivebrokers.com</a> with your live credentials.
  </div>

  <div class="step">
    Top-right menu (head &amp; shoulders icon) → <strong>Settings</strong>.
    In the search box on the left, type
    <em>secure login</em>, then click <strong>Secure Login System</strong>.
  </div>

  <div class="step">
    Click <strong>Add a Second Factor</strong> → choose
    <strong>Authenticator App</strong> (sometimes labelled "Soft
    Token" depending on region).
  </div>

  <div class="step">
    IBKR shows a QR code with the <strong>Activation Code</strong>
    printed underneath. <strong>Copy the Activation Code</strong> —
    that's what you paste into the gateway. Treat it like a password
    (anyone with it can mint codes against your account).
  </div>

  <div class="step">
    <strong>Also scan the QR with a real authenticator app</strong>
    on your phone (Google Authenticator, Authy, 1Password, Yubico
    Authenticator — any of them). This gives you a manual fallback
    if the activation code ever gets lost or revoked.
  </div>

  <div class="step">
    Click <strong>Continue</strong>. IBKR asks you to type the
    current 6-digit code from your authenticator app to prove
    enrollment succeeded. Type it; you're done.
  </div>
</div>

<div class="ok">
  <strong>Keep IB Key (or another second factor) enrolled too.</strong>
  Don't make Authenticator App your only method. If you lose the
  activation code and the gateway loses it too, you would need to
  go through IBKR's account-recovery process, which can take days.
</div>

<h2>Verifying it works</h2>
<ol>
  <li>
    Log out of the IBKR Client Portal completely.
  </li>
  <li>
    Log back in with your live username + password. After submitting,
    IBKR should show a <strong>"Select Second Factor Device"</strong>
    page (because you now have both IB Key and Authenticator App).
    Pick <strong>Authenticator App</strong>; type the current 6-digit
    code from your phone; you should land in the portal.
  </li>
</ol>

<h2>Using it in this gateway</h2>

<h3>From the CLI</h3>
<p>
  Run <code>node cli/ibkr.js</code> and choose <strong>live</strong> mode.
  After username and password, the CLI prompts:
</p>
<div class="card" style="font-family: ui-monospace, monospace; white-space: pre;">Mode [paper/live] (default 'live'): live
Username: myuser
Password: *************
Activation code: ****************************</div>
<p>
  Paste the activation code (the base32 secret, not a 6-digit code).
  The CLI computes the current TOTP locally and fills it into IBKR's
  2FA page on your behalf — no phone needed. The activation code is
  saved into <code>~/.ibkr-cli/session.json</code> at mode 0600 so
  subsequent runs are fully unattended.
</p>

<h3>From the web console (planned)</h3>
<p>
  When the web service launches, the connection-creation form will
  ask for username, password, and the activation code at the same
  time. For live mode all three are mandatory. The activation code
  is stored in
  <a href="https://cloud.google.com/secret-manager" target="_blank" rel="noopener">
  GCP Secret Manager</a> (never plaintext in Firestore), and used
  by the gateway to re-auth your IBKR session whenever IBKR drops it.
</p>

<hr />

<h2>Security</h2>
<ul>
  <li>
    The activation code is <strong>at-rest credential material</strong>.
    Anyone with the file can log into your account, indefinitely,
    until you re-enroll on IBKR.
  </li>
  <li>
    On the CLI: stored in <code>~/.ibkr-cli/session.json</code>, file
    mode 0600. Fine for a single user's laptop. Not fine if that
    laptop is shared or backed up to a public cloud.
  </li>
  <li>
    On the gateway: stored in GCP Secret Manager. Access is mediated
    by the service account; the value never appears in logs or in
    Firestore.
  </li>
  <li>
    <strong>If you suspect a leak:</strong> Client Portal → Settings →
    Secure Login System → remove Authenticator App → re-add. The old
    secret is invalidated immediately, and you'll get a new
    activation code to paste into the gateway.
  </li>
</ul>

<h2>Rotating the activation code</h2>
<ol>
  <li>Remove Authenticator App in the IBKR portal.</li>
  <li>Add it again. Copy the new activation code.</li>
  <li>Re-run <code>node cli/ibkr.js</code> with the same live
      username and the new activation code. The gateway overwrites
      the old one in <code>session.json</code>.</li>
</ol>

<p class="muted">
  Last verified against IBKR's portal in May 2026. If the menu has
  moved, search for "secure login" or "two-factor" in Account Settings.
</p>
`,
  });
}
