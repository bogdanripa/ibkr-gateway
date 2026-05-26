// / — the public marketing homepage. Plain HTML, no JS, no auth.
//
// Purpose: explain what IBKR Gateway is to humans, LLM crawlers, and
// search engines, then route visitors who want to sign up into the
// /console SPA. The console SPA is React-ish but tiny; we don't want
// to load it for every drive-by visit.
//
// LLM/SEO optimisation choices:
//   · Semantic HTML5 (header / main / article / section / footer).
//   · One clear <h1>, hierarchical <h2>/<h3> with verbatim feature
//     names ("MCP server", "OAuth 2.1", "scope") so models can
//     extract capabilities without inferring.
//   · A short TL;DR paragraph immediately under the hero so RAG/
//     summariser models see the value prop in the first 200 tokens.
//   · Plain declarative prose. No marketing fluff that resists
//     extraction.
//   · JSON-LD SoftwareApplication + WebSite + FAQPage schema for
//     structured indexing.
//   · OpenGraph + Twitter cards.
//   · `<link rel="canonical">` and a stable robots policy.

import {
  FAVICON_LINK,
  MARKETING_CHROME_CSS,
  REPO_URL,
  marketingFooterHtml,
  marketingHeaderHtml,
} from "./marketing.js";

export function homeHtml(origin: string): string {
  const title = "IBKR Gateway — Connect Claude, ChatGPT, Cursor & MCP clients to Interactive Brokers";
  const description =
    "IBKR Gateway is an open bridge that turns your Interactive Brokers account into an MCP (Model Context Protocol) endpoint. Plug Claude, ChatGPT, Cursor, or any MCP-compatible AI host into IBKR with OAuth — read-only for analysis, read & write for trading. Free, hosted, scoped per app.";
  const jsonLd = JSON.stringify(
    [
      {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: "IBKR Gateway",
        applicationCategory: "FinanceApplication",
        operatingSystem: "Web",
        url: origin,
        description,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        featureList: [
          "MCP (Model Context Protocol) server for Interactive Brokers",
          "OAuth 2.1 with PKCE and dynamic client registration",
          "Per-app scopes: read-only or read & write",
          "Live and paper IBKR account support",
          "Unattended live authentication via TOTP (Authenticator App)",
          "Quotes, history, portfolio, cash ledger, order placement and cancellation",
        ],
      },
      {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: "IBKR Gateway",
        url: origin,
      },
      {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: [
          {
            "@type": "Question",
            name: "What is IBKR Gateway?",
            acceptedAnswer: {
              "@type": "Answer",
              text:
                "IBKR Gateway is a free hosted service that exposes your Interactive Brokers account through the Model Context Protocol so AI tools like Claude, ChatGPT, and Cursor can query positions, fetch quotes, and (with your consent) place orders.",
            },
          },
          {
            "@type": "Question",
            name: "How does IBKR Gateway authenticate AI tools?",
            acceptedAnswer: {
              "@type": "Answer",
              text:
                "Hosts authenticate via OAuth 2.1 with PKCE and Dynamic Client Registration. Tokens are bound to a specific IBKR connection and a specific scope (read-only or read & write), so you control exactly what each app can do.",
            },
          },
          {
            "@type": "Question",
            name: "Can Claude or ChatGPT place trades on my IBKR account?",
            acceptedAnswer: {
              "@type": "Answer",
              text:
                "Only if you explicitly grant the read & write scope during the consent flow. With read-only scope, place_order and cancel_order are not even visible in the tools list — applies equally to Claude, ChatGPT, Cursor, and any other MCP host.",
            },
          },
          {
            "@type": "Question",
            name: "Does IBKR Gateway support paper trading?",
            acceptedAnswer: {
              "@type": "Answer",
              text:
                "Yes. Paper and live accounts are both first-class connection types. Use a paper account to test integrations before pointing real money at them.",
            },
          },
          {
            "@type": "Question",
            name: "Where does IBKR Gateway store my credentials?",
            acceptedAnswer: {
              "@type": "Answer",
              text:
                "IBKR username, password, and (for live accounts) Authenticator App activation code are stored encrypted in Google Cloud Secret Manager and never leave the gateway VM. The gateway re-authenticates against IBKR's Client Portal on your behalf.",
            },
          },
        ],
      },
    ],
    null,
    2,
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<link rel="canonical" href="${escapeHtml(origin)}/" />
<meta name="robots" content="index, follow" />
${FAVICON_LINK}

<meta property="og:type" content="website" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${escapeHtml(origin)}/" />
<meta property="og:site_name" content="IBKR Gateway" />

<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />

<script type="application/ld+json">${jsonLd}</script>

<style>
  ${MARKETING_CHROME_CSS}

  main { max-width: 880px; margin: 0 auto; padding: 0 24px; }
  section { padding: 64px 0; border-bottom: 1px solid var(--border); }
  section:last-of-type { border-bottom: none; }
  h1 {
    font-size: 44px; line-height: 1.1; margin: 0 0 16px;
    letter-spacing: -0.02em; font-weight: 700;
  }
  h2 {
    font-size: 26px; margin: 0 0 14px;
    letter-spacing: -0.01em; font-weight: 600;
  }
  h3 { font-size: 17px; margin: 18px 0 6px; font-weight: 600; }
  p { margin: 0 0 14px; color: #d6d9de; }
  .muted { color: var(--muted); }
  .lead { font-size: 19px; color: #d6d9de; max-width: 660px; }

  .hero { padding-top: 80px; padding-bottom: 56px; }
  .hero .actions { margin-top: 28px; display: flex; gap: 12px; flex-wrap: wrap; }
  .btn {
    display: inline-block; padding: 12px 20px; border-radius: 10px;
    text-decoration: none; font-weight: 500; font-size: 15px;
    border: 1px solid var(--border); color: var(--text);
  }
  .btn.primary { background: var(--accent); border-color: var(--accent); }
  .btn.primary:hover { filter: brightness(1.1); }
  .btn.ghost:hover { background: var(--card); }
  .tldr {
    margin-top: 32px; padding: 14px 18px;
    background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    font-size: 15px;
  }
  .tldr strong { color: var(--ok); }

  .grid {
    display: grid; gap: 16px;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    margin-top: 20px;
  }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    padding: 18px 20px;
  }
  .card h3 { margin-top: 0; }

  ul, ol { padding-left: 22px; margin: 8px 0 14px; color: #d6d9de; }
  li { margin: 4px 0; }
  details {
    border: 1px solid var(--border); border-radius: 8px;
    padding: 14px 18px; background: var(--card); margin: 10px 0;
  }
  details summary { cursor: pointer; font-weight: 500; }
  details[open] summary { margin-bottom: 8px; }

  @media (max-width: 720px) {
    main { padding: 0 16px; }
    h1 { font-size: 30px; }
    h1 br { display: none; }
    h2 { font-size: 22px; }
    .lead { font-size: 17px; }
    .hero { padding-top: 36px; padding-bottom: 36px; }
    section { padding: 40px 0; }
    .btn { padding: 11px 16px; font-size: 14px; }
    .hero .actions .btn { width: 100%; text-align: center; }
    .card { padding: 16px; }
    .tldr { padding: 12px 14px; font-size: 14px; }
    details { padding: 12px 14px; }
  }
</style>
</head>
<body>

${marketingHeaderHtml()}

<main>

<section class="hero" aria-labelledby="hero-h">
  <h1 id="hero-h">Bring AI tools to your <br/>Interactive Brokers account</h1>
  <p class="lead">
    IBKR Gateway is a free, hosted bridge that exposes your Interactive
    Brokers account over the
    <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener">Model Context Protocol (MCP)</a>.
    Plug Claude, ChatGPT, Cursor, or any MCP-compatible AI host into
    IBKR with one consent screen. Read-only by default, read &amp; write only when you
    grant it — per app, per connection.
  </p>
  <div class="actions">
    <a class="btn primary" href="/console">Sign in &amp; get started</a>
    <a class="btn ghost" href="/help/mcp">Read the MCP guide</a>
  </div>
  <div class="tldr">
    <strong>TL;DR.</strong> Sign in with Google → add an IBKR connection
    (paper or live) → point Claude at <code>${escapeHtml(origin)}/mcp</code> →
    pick read or read&amp;write on the consent screen → start asking Claude
    about your portfolio.
  </div>
</section>

<section aria-labelledby="features-h">
  <h2 id="features-h">What you get</h2>
  <div class="grid">
    <article class="card">
      <h3>An MCP server for IBKR</h3>
      <p>
        A single endpoint at <code>${escapeHtml(origin)}/mcp</code> that any
        MCP host can connect to. 13 tools covering accounts, quotes,
        history, portfolio, cash, orders. Speaks JSON-RPC 2.0 over HTTP.
      </p>
    </article>
    <article class="card">
      <h3>Proper OAuth, not API keys</h3>
      <p>
        OAuth 2.1 + PKCE + Dynamic Client Registration. Hosts auto-discover
        the authorization endpoints via
        <code>/.well-known/oauth-protected-resource</code>. You sign in
        with Google and explicitly consent to each app.
      </p>
    </article>
    <article class="card">
      <h3>Scoped per app</h3>
      <p>
        Each authorization is bound to one IBKR connection and one scope.
        <strong>Read-only</strong> hides <code>place_order</code> and
        <code>cancel_order</code> from the tools list entirely.
        <strong>Read &amp; write</strong> unlocks them. Revoke any
        app from the console at any time.
      </p>
    </article>
    <article class="card">
      <h3>Paper and live accounts</h3>
      <p>
        Both are first-class. Develop against a paper account, then point
        the same MCP client at a live connection when you're ready. Live
        connections sign in unattended via the IBKR Authenticator App
        (TOTP).
      </p>
    </article>
    <article class="card">
      <h3>API keys for programmatic access</h3>
      <p>
        Not every caller is an AI host. Every connection auto-generates
        a per-connection API key on creation, and you can mint more
        from the console. Any third-party app, script, scheduled job
        or backend service can call <code>/mcp</code> with it as a
        static <code>Authorization: Bearer</code> credential — no
        OAuth dance required.
      </p>
    </article>
    <article class="card">
      <h3>Credentials in Secret Manager</h3>
      <p>
        IBKR username, password, and Authenticator App secret live in
        Google Cloud Secret Manager — encrypted at rest, never exposed
        to other tenants, never logged.
      </p>
    </article>
  </div>
</section>

<section aria-labelledby="how-h">
  <h2 id="how-h">How it works</h2>
  <ol>
    <li>
      You <a href="/console">sign in</a> with Google and add an IBKR
      connection. Paper credentials work out of the box; live requires
      the
      <a href="/help/authenticator-app">Authenticator App</a> activation
      code so the gateway can sign you in unattended.
    </li>
    <li>
      In your AI host (Claude.ai → Settings → Connectors → Add custom,
      Claude Desktop's <code>claude_desktop_config.json</code>, Cursor's
      MCP settings, etc.), you point it at
      <code>${escapeHtml(origin)}/mcp</code>.
    </li>
    <li>
      The host kicks off OAuth: it opens a consent screen on this site,
      you pick which IBKR connection to expose, you pick read-only vs
      read &amp; write, and you approve.
    </li>
    <li>
      The host now holds a scoped access token. It calls
      <code>get_portfolio</code>, <code>get_quote</code>,
      <code>place_order</code>, etc. The gateway routes each call to
      IBKR's Client Portal under your existing session.
    </li>
    <li>
      You can revoke the app at any time from the
      <em>Connected apps</em> panel in the
      <a href="/console">console</a>.
    </li>
  </ol>
</section>

<section aria-labelledby="hosts-h">
  <h2 id="hosts-h">Tested hosts</h2>
  <div class="grid">
    <article class="card">
      <h3>Claude.ai</h3>
      <p>Settings → Connectors → Add custom →
      <code>${escapeHtml(origin)}/mcp</code>. Walks the OAuth flow in a popup.</p>
    </article>
    <article class="card">
      <h3>Claude Desktop</h3>
      <p>Drop the URL into <code>claude_desktop_config.json</code> under
      <code>mcpServers</code>. Same OAuth dance on first contact.</p>
    </article>
    <article class="card">
      <h3>ChatGPT</h3>
      <p>Settings → Connectors → Create → paste
      <code>${escapeHtml(origin)}/mcp</code>. Available on plans that
      expose custom connectors (Business, Enterprise, Edu, Pro).</p>
    </article>
    <article class="card">
      <h3>Cursor</h3>
      <p>Cursor's MCP support uses the same OAuth profile — point it at
      the URL and follow the prompts.</p>
    </article>
    <article class="card">
      <h3>Anything else MCP-compatible</h3>
      <p>If the host implements MCP's OAuth 2.1 + DCR profile, it
      auto-discovers the endpoints from our metadata documents.</p>
    </article>
  </div>
</section>

<section aria-labelledby="tools-h">
  <h2 id="tools-h">The MCP tools</h2>
  <ul>
    <li><code>get_accounts</code> — list every sub-account on the connection.</li>
    <li><code>get_current_account</code> / <code>set_current_account</code> — read or pin the implicit sub-account (set is write-scope).</li>
    <li><code>get_portfolio</code> — stocks, options, other positions, plus the cash ledger.</li>
    <li><code>get_cash</code> — cash balances per currency.</li>
    <li><code>search_security</code> — find a contract by ticker or company name; returns conid + exchange + secTypes.</li>
    <li><code>get_quote</code> — snapshot last / bid / ask / day H/L / change for one contract.</li>
    <li><code>get_history</code> — OHLCV bars over a period.</li>
    <li><code>get_change</code> — first→last close % change over a period.</li>
    <li><code>get_orders</code> / <code>get_order_status</code> — live order book.</li>
    <li><code>place_order</code> — place an equity order (MKT / LMT / STP / STP_LIMIT). <em>Write scope only.</em></li>
    <li><code>cancel_order</code> — cancel a working order by id. <em>Write scope only.</em></li>
  </ul>
  <p>
    The full reference lives on the
    <a href="/help/mcp">MCP guide</a>, including exactly which tools
    disappear from <code>tools/list</code> in read-only mode.
  </p>
</section>

<section aria-labelledby="selfhost-h">
  <h2 id="selfhost-h">Don't want to share your IBKR credentials with us? Run your own.</h2>
  <p>
    The hosted instance at <code>${escapeHtml(origin)}</code> stores
    your IBKR username + password (and Authenticator App secret, for
    live) in Google Cloud Secret Manager under our project. If you'd
    rather keep that custody to yourself, the gateway is fully
    open-source and self-hostable — same code, same MCP surface, same
    OAuth flow, just running on your own infrastructure.
  </p>
  <ul>
    <li>
      The repo is at
      <a href="${escapeHtml(REPO_URL)}" target="_blank" rel="noopener">
        github.com/bogdanripa/ibkr-gateway</a>.
    </li>
    <li>
      <a href="${escapeHtml(REPO_URL)}#readme" target="_blank" rel="noopener">README</a>
      walks through a single-VM GCP deployment end-to-end: Firestore,
      Secret Manager, the systemd unit, Caddy + TLS, Firebase Auth, the
      GitHub Actions deploy workflow.
    </li>
    <li>
      Stack: Node 22 + Express + Firestore + GCP Secret Manager +
      Playwright (for IBKR's headless login). No proprietary
      dependencies, no licence wall.
    </li>
    <li>
      The cost on the reference deployment is roughly a single
      <code>e2-small</code> VM ($15-ish/month) plus a free-tier
      Firestore database.
    </li>
  </ul>
  <p class="muted">
    Either way, IBKR sees the same Client Portal traffic — the only
    difference is who holds the keys to the secret store.
  </p>
  <div class="actions">
    <a class="btn ghost" href="${escapeHtml(REPO_URL)}" target="_blank" rel="noopener">View on GitHub</a>
    <a class="btn ghost" href="${escapeHtml(REPO_URL)}#readme" target="_blank" rel="noopener">Read the deploy guide</a>
  </div>
</section>

<section aria-labelledby="security-h">
  <h2 id="security-h">Security model</h2>
  <ul>
    <li>
      <strong>You own the connection.</strong> Credentials are stored in
      Google Cloud Secret Manager, encrypted at rest, scoped to your
      account record only.
    </li>
    <li>
      <strong>Tokens are scoped at consent time.</strong> An app
      granted read-only literally cannot invoke
      <code>place_order</code> — it returns JSON-RPC error
      <code>-32004</code> and the tool isn't even listed.
    </li>
    <li>
      <strong>Tokens expire.</strong> 30-day access tokens by default;
      stored as <code>sha256</code> hashes (not the raw token) on our
      side. Revoke instantly from the console.
    </li>
    <li>
      <strong>Every call is auditable.</strong> Failed tool calls and
      auth-middleware errors get persisted with the source (OAuth or
      API key), scope, connection, and IP, with a 14-day Firestore TTL.
    </li>
  </ul>
</section>

<section aria-labelledby="faq-h">
  <h2 id="faq-h">FAQ</h2>

  <details>
    <summary>Is this free?</summary>
    <p>
      Yes. The gateway is an open-source side project running on a single
      GCP VM. There's no usage-based billing or feature gating.
    </p>
  </details>

  <details>
    <summary>Do I need to install anything?</summary>
    <p>
      No. The gateway is hosted at
      <code>${escapeHtml(origin)}</code>. Sign in, add a connection,
      point your MCP host at <code>/mcp</code>. That's it.
    </p>
  </details>

  <details>
    <summary>Can Claude or ChatGPT actually trade my account?</summary>
    <p>
      Only if you grant the <strong>read &amp; write</strong> scope on
      the consent screen. With read-only, <code>place_order</code> and
      <code>cancel_order</code> aren't visible to the host and would
      be rejected server-side anyway. The toggle is per app.
    </p>
  </details>

  <details>
    <summary>How does IBKR see this — am I breaking ToS?</summary>
    <p>
      The gateway uses IBKR's official Client Portal Web API (the same
      surface their Java CPG jar exposes). It signs in using your normal
      IBKR credentials. There's no scraping, no unofficial endpoint.
    </p>
  </details>

  <details>
    <summary>Can I host my own instance?</summary>
    <p>
      Yes — fork
      <a href="${escapeHtml(REPO_URL)}" target="_blank" rel="noopener">the repo on GitHub</a>
      and follow the
      <a href="${escapeHtml(REPO_URL)}#readme" target="_blank" rel="noopener">README</a>.
      It documents a single-VM GCP deployment (Firestore, Secret
      Manager, systemd, Caddy + TLS, Firebase Auth, GitHub Actions).
      If you'd rather not share your IBKR credentials with the hosted
      instance, self-hosting is the answer.
    </p>
  </details>

  <details>
    <summary>What about non-MCP / programmatic clients?</summary>
    <p>
      Use the per-connection API key. It's auto-generated when you
      create a connection and works as a static
      <code>Authorization: Bearer</code> credential against
      <code>/mcp</code> — usable from any third-party app, server,
      script, notebook, or cron job. Same tool surface as the OAuth
      path, no consent screen, no token refresh.
    </p>
  </details>
</section>

<section aria-labelledby="cta-h">
  <h2 id="cta-h">Ready to wire Claude or ChatGPT into your IBKR account?</h2>
  <p>
    Sign in with Google, add a paper or live IBKR connection, then
    point Claude, ChatGPT, Cursor, or your own MCP client at
    <code>${escapeHtml(origin)}/mcp</code>. The consent screen takes
    about ten seconds.
  </p>
  <div class="actions">
    <a class="btn primary" href="/console">Sign in &amp; get started</a>
    <a class="btn ghost" href="/help/mcp">Read the MCP guide</a>
  </div>
</section>

</main>

${marketingFooterHtml()}

</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] ?? c),
  );
}
