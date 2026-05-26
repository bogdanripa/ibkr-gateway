// /privacy — public Privacy Policy for the hosted instance of IBKR
// Gateway. No auth. Uses the same chrome as the other marketing
// pages via renderHelpPage.

import { renderHelpPage } from "./layout.js";

export function privacyHtml(): string {
  return renderHelpPage({
    title: "Privacy Policy",
    bodyHtml: `
<h1>Privacy Policy</h1>

<p class="muted">Last updated: 2026-05-26</p>

<p>
  This policy explains what the hosted IBKR Gateway service at
  <code>ibkr-gateway.bogdanripa.com</code> collects, why, how long it
  is kept, and your choices. If you self-host the open-source code on
  your own infrastructure, this policy does not apply — you control
  the data.
</p>

<h2>1. What we collect</h2>
<ul>
  <li>
    <strong>Your Google account email</strong>, via Firebase
    Authentication, when you sign in. Used as your account
    identifier.
  </li>
  <li>
    <strong>Your IBKR credentials</strong>, when you add a
    connection: username, password, and (for live accounts) the
    Authenticator App activation code (the base32 TOTP secret).
  </li>
  <li>
    <strong>Connection metadata</strong>: your connection label,
    IBKR account ID, paper-vs-live mode.
  </li>
  <li>
    <strong>OAuth client registrations and token records</strong>
    for AI hosts you authorize against the gateway.
  </li>
  <li>
    <strong>Audit log entries</strong> for failed tool calls and
    authentication errors — including timestamp, source (oauth or
    apikey), scope, connection identifier, and IP address. Used to
    investigate breakage and abuse.
  </li>
</ul>
<p class="muted">
  We do not collect personally-identifying information beyond your
  email and IBKR username, and we do not run any third-party
  analytics, advertising, or tracking pixels.
</p>

<h2>2. Where it is stored</h2>
<ul>
  <li>
    <strong>IBKR credentials</strong> (username, password,
    Authenticator App activation code) are stored in
    <a href="https://cloud.google.com/secret-manager" target="_blank" rel="noopener">Google Cloud Secret Manager</a>,
    encrypted at rest under Google-managed keys. They never appear in
    our database, our logs, or any API response.
  </li>
  <li>
    <strong>OAuth access tokens</strong> are stored as
    <code>sha-256</code> hashes — never as the raw token. The raw
    token leaves the server exactly once, in the response body of the
    <code>/oauth/token</code> call that issued it.
  </li>
  <li>
    <strong>Account, connection, OAuth client, and audit-log
    records</strong> are stored in
    <a href="https://cloud.google.com/firestore" target="_blank" rel="noopener">Google Cloud Firestore</a>
    inside a Google Cloud project we operate.
  </li>
</ul>

<h2>3. Retention</h2>
<ul>
  <li>
    Audit log entries have a <strong>14-day Firestore TTL</strong> —
    they are deleted automatically after that window.
  </li>
  <li>
    Account, connection, and OAuth records persist until you delete
    them yourself from the <a href="/console">console</a>.
  </li>
  <li>
    Deleting a connection also deletes its IBKR credentials from
    Secret Manager. Revoking an authorized app deletes the
    corresponding OAuth tokens from Firestore.
  </li>
</ul>

<h2>4. Sharing</h2>
<ul>
  <li>
    We do not sell, rent, or otherwise share your data with third
    parties for their own purposes.
  </li>
  <li>
    <strong>Google Cloud</strong> (Firestore, Secret Manager, Firebase
    Auth) acts as a sub-processor under Google's terms.
  </li>
  <li>
    <strong>Interactive Brokers</strong> receives your IBKR
    credentials when the gateway signs in on your behalf — same as
    if you signed in yourself. The gateway uses IBKR's official
    Client Portal Web API and does not bypass any IBKR security
    control.
  </li>
  <li>
    <strong>AI hosts you authorize</strong> (Claude, ChatGPT, Cursor,
    etc.) receive a scoped OAuth access token. They do not receive
    your IBKR credentials. They see only the data returned by tool
    calls they make — quotes, positions, orders, etc.
  </li>
</ul>

<h2>5. Cookies and local storage</h2>
<p>
  Firebase Authentication sets cookies and local-storage entries in
  your browser to keep you signed in across reloads. These are
  necessary for the Service to function. We do not set any other
  cookies, and we do not use third-party tracking, analytics, or
  advertising cookies.
</p>

<h2>6. Your choices</h2>
<ul>
  <li>Sign out at any time from the <a href="/console">console</a>.</li>
  <li>
    Delete a connection at any time — its IBKR credentials are
    removed from Secret Manager as part of the deletion.
  </li>
  <li>
    Revoke any authorized AI host from the <em>Connected apps</em>
    panel in the console.
  </li>
  <li>
    Request full account deletion by emailing
    <a href="mailto:ibkr.marketplace@bogdanripa.com">ibkr.marketplace@bogdanripa.com</a>.
    We will remove your account record, all your connections, all
    your OAuth records, and all Secret Manager entries tied to them.
  </li>
</ul>

<h2>7. Children</h2>
<p>
  The Service is not directed to children under 16, and we do not
  knowingly collect data from anyone under 16. Do not use the Service
  if you are under 16.
</p>

<h2>8. Self-hosting</h2>
<p>
  The Service is fully open-source. If you would rather not share
  IBKR credentials with us, run your own instance — same code, same
  MCP surface, same OAuth flow. See
  <a href="https://github.com/bogdanripa/ibkr-gateway" target="_blank" rel="noopener">github.com/bogdanripa/ibkr-gateway</a>
  for the deploy guide.
</p>

<h2>9. Changes to this policy</h2>
<p>
  We may update this policy as the Service changes. The "Last
  updated" date above reflects the most recent revision. Material
  changes will be highlighted on this page.
</p>

<h2>10. Contact</h2>
<p>
  Questions or deletion requests:
  <a href="mailto:ibkr.marketplace@bogdanripa.com">ibkr.marketplace@bogdanripa.com</a>.
</p>

<p class="muted">
  See also the <a href="/terms">Terms of Use</a>.
</p>
`,
  });
}
