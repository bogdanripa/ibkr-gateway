// /help/mcp — explains the MCP server: what it is, how to wire it up
// from Claude.ai / Cursor / Claude Desktop, what scopes mean, and
// what each tool does. Public, no auth required.

import { renderHelpPage } from "./layout.js";

export function mcpHelpHtml(): string {
  return renderHelpPage({
    title: "Connect Claude / ChatGPT / Cursor (MCP)",
    bodyHtml: `
<h1>Connect Claude, ChatGPT, Cursor, or any MCP host to your IBKR account</h1>

<p>
  IBKR Gateway exposes an
  <a href="https://modelcontextprotocol.io" target="_blank">MCP</a>
  (Model Context Protocol) server at
  <code>https://ibkr-gateway.bogdanripa.com/mcp</code>.
  Any MCP-compatible host — Claude.ai's Custom Connectors, Claude
  Desktop, ChatGPT's Custom Connectors, Cursor, your own scripts —
  can use it to query positions, pull quotes, and (with your explicit
  consent) place orders against one of your IBKR connections.
</p>

<div class="ok">
  <strong>OAuth, not API keys.</strong> When you connect a host like
  Claude, it walks you through a normal "sign in with Google +
  consent" flow on this site. You pick which IBKR connection to
  expose and whether the host can place trades or only read. No
  shared secrets to copy-paste.
</div>

<h2>Connect from Claude.ai</h2>
<ol class="steps">
  <li class="step">
    <strong>Set up an IBKR connection first.</strong> Go to the
    <a href="/console">console</a>, sign in, and add a paper or live
    connection. (See <a href="/help/paper-account">paper accounts</a>
    or <a href="/help/authenticator-app">live setup</a>.)
  </li>
  <li class="step">
    <strong>In Claude.ai, add a custom connector.</strong>
    Settings → Connectors → Add custom connector. Paste
    <code>https://ibkr-gateway.bogdanripa.com/mcp</code>.
  </li>
  <li class="step">
    <strong>Authorize.</strong> Claude opens a popup pointing at
    this site's consent screen. Sign in with the same Google
    account you use for the console. Pick which IBKR connection to
    expose and the scope (read-only or read &amp; write). Approve.
  </li>
  <li class="step">
    <strong>Use the tools.</strong> Claude can now call
    <code>get_quote</code>, <code>get_portfolio</code>, and the
    rest. Try <em>"what's my IBKR portfolio worth right now?"</em>
    or <em>"get a quote for NVDA"</em>.
  </li>
</ol>

<h2>Connect from ChatGPT</h2>
<ol class="steps">
  <li class="step">
    <strong>Set up an IBKR connection first</strong> (same as above).
  </li>
  <li class="step">
    <strong>In ChatGPT, open Settings → Connectors → Create.</strong>
    Pick "Custom connector" / "MCP server" (the label varies by
    plan). Paste
    <code>https://ibkr-gateway.bogdanripa.com/mcp</code> as the
    server URL.
  </li>
  <li class="step">
    <strong>Authorize.</strong> ChatGPT opens this site's consent
    screen, you sign in with Google, pick the IBKR connection and
    the scope (read-only or read &amp; write), and approve.
  </li>
  <li class="step">
    <strong>Use the tools.</strong> The IBKR tools show up under
    the connector — ask ChatGPT to <em>"check my IBKR portfolio"</em>
    or <em>"quote SPY"</em>.
  </li>
</ol>
<p class="muted">
  MCP-over-HTTP for custom connectors is only available on
  ChatGPT plans that expose the connector / agent features
  (Business, Enterprise, Edu, and Pro at the time of writing).
  If you don't see the "Create" option, your plan may not have it.
</p>

<h2>Connect from Claude Desktop</h2>
<p>
  Add the gateway to your <code>claude_desktop_config.json</code>:
</p>
<pre class="card" style="overflow-x:auto;"><code>{
  "mcpServers": {
    "ibkr-gateway": {
      "url": "https://ibkr-gateway.bogdanripa.com/mcp"
    }
  }
}</code></pre>
<p>
  Claude Desktop will run the OAuth dance the first time the server
  is contacted — same consent screen as Claude.ai.
</p>

<h2>Connect from Cursor or any other host</h2>
<p>
  Point your MCP client at <code>https://ibkr-gateway.bogdanripa.com/mcp</code>.
  Any host that implements MCP's OAuth 2.1 + Dynamic Client
  Registration profile will auto-discover the authorization
  endpoints via
  <a href="/.well-known/oauth-protected-resource">/.well-known/oauth-protected-resource</a>.
</p>

<h2>Scopes</h2>
<div class="card">
  <p style="margin-top:0;">
    <strong>Read-only</strong> — the host can list accounts, snap
    quotes, pull history, and read your portfolio &amp; order book.
    It <em>cannot</em> place or cancel orders, or switch which
    sub-account is active. Recommended for analysis-only use.
  </p>
  <p style="margin-bottom:0;">
    <strong>Read &amp; write</strong> — the host can do all of the
    above <em>plus</em> place and cancel orders. Required if you
    want Claude to actually execute trades. You get to pick the
    scope on every consent screen.
  </p>
</div>
<p>
  Scope is bound to the token at consent time. To switch scopes
  later, re-authorize on the consent screen — old tokens stay
  valid until you revoke them from the console's
  <em>Connected apps</em> panel.
</p>

<h2>What each tool does</h2>
<ul>
  <li><code>get_accounts</code> — list every IBKR sub-account on the connection.</li>
  <li><code>get_current_account</code> / <code>set_current_account</code> — read or pin the implicit sub-account.</li>
  <li><code>get_portfolio</code> — stocks, options, other positions, cash ledger.</li>
  <li><code>get_cash</code> — cash ledger by currency.</li>
  <li><code>search_security</code> — search IBKR's security master by ticker or company name.</li>
  <li><code>get_quote</code> — snapshot last/bid/ask/day H/L for one contract.</li>
  <li><code>get_history</code> — OHLCV bars.</li>
  <li><code>get_change</code> — first→last close % change over a period.</li>
  <li><code>get_orders</code> / <code>get_order_status</code> — live order book.</li>
  <li><code>place_order</code> — place an equity order (MKT / LMT / STP / STP_LIMIT). <em>write scope only</em>.</li>
  <li><code>cancel_order</code> — cancel a working order by id. <em>write scope only</em>.</li>
</ul>
<p class="muted">
  Read-only clients won't even see <code>place_order</code> /
  <code>cancel_order</code> / <code>set_current_account</code> in
  the tools list — they're filtered out server-side based on the
  scope of the token.
</p>

<h2>Managing connected hosts</h2>
<p>
  The console's
  <a href="/console">Connected apps</a> panel
  lists every host that's been authorized, with the IBKR
  connection + scope + last-used timestamp. Revoke from there to
  cut a host off immediately.
</p>

<h2>API keys (programmatic access)</h2>
<p>
  Not every caller is an AI host walking through OAuth. Any
  third-party app, backend service, script, notebook, or
  scheduled job can hit the same <code>/mcp</code> endpoint with a
  per-connection API key — no consent screen, no token refresh, no
  Firebase sign-in. The key goes on the request as a static
  <code>Authorization: Bearer &lt;key&gt;</code> header.
</p>
<p>
  Connections auto-generate a <code>default</code> key on creation;
  you can mint additional keys (and revoke individual ones) from
  the <a href="/console">console</a>. API-key callers get full
  read+write access against the connection the key belongs to.
</p>
<pre class="card"><code>curl -sS https://ibkr-gateway.bogdanripa.com/mcp \\
  -H "Authorization: Bearer ibkr_..." \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'</code></pre>
<p class="muted">
  Either way, every call against <code>/mcp</code> is logged with
  source (oauth or apikey), scope, and the connection it touched.
  Audit trail lives in the
  <em>Recent errors</em> panel for failures and in the per-key
  Last used column for successes.
</p>
`,
  });
}
