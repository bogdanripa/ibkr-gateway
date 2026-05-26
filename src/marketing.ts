// Shared chrome (header, footer, base CSS) for the public marketing
// surface: the homepage at "/" and the /help/* pages. Keeping it in
// one place means the brand, the nav, the colour palette and the
// mobile breakpoints are identical no matter which page the visitor
// (or crawler) lands on first.
//
// Pure HTML strings — no JS, no build step. The pages still render
// in a single GET.

export const REPO_URL = "https://github.com/bogdanripa/ibkr-gateway";

// Variables + body + chrome (header + footer) + a couple of generic
// helpers (code, links, sticky header on desktop). Page-specific
// styles (cards, grids, etc.) live in the individual page modules.
export const MARKETING_CHROME_CSS = `
  :root {
    --bg: #0b0d10;
    --card: #14181d;
    --border: #2a3038;
    --text: #e8eaed;
    --muted: #9aa3ad;
    --accent: #5b8def;
    --ok: #4ade80;
    --warn: #d39654;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 16px/1.65 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: var(--text);
    background:
      radial-gradient(800px 400px at 50% -10%, rgba(91, 141, 239, 0.18), transparent 60%),
      var(--bg);
    min-height: 100vh;
    -webkit-text-size-adjust: 100%;
  }
  img, svg { max-width: 100%; height: auto; }
  a { color: var(--accent); }
  code {
    background: var(--card);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 0.92em;
    word-break: break-word;
  }
  pre {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 8px; padding: 14px 16px;
    overflow-x: auto; max-width: 100%;
    font-size: 13px; line-height: 1.5;
  }
  pre code { background: transparent; border: none; padding: 0; }

  header.site {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px 20px; flex-wrap: wrap;
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
    background: rgba(11, 13, 16, 0.78);
    backdrop-filter: saturate(150%) blur(8px);
    -webkit-backdrop-filter: saturate(150%) blur(8px);
    position: sticky; top: 0; z-index: 10;
  }
  header.site .brand {
    font-weight: 600; font-size: 16px; letter-spacing: 0.02em;
    color: var(--text); text-decoration: none;
    white-space: nowrap;
  }
  header.site nav {
    display: flex; align-items: center;
    gap: 6px 18px; flex-wrap: wrap;
  }
  header.site nav a {
    font-size: 14px; text-decoration: none; color: var(--muted);
    white-space: nowrap;
  }
  header.site nav a:hover { color: var(--text); }
  header.site nav a.cta {
    color: var(--text); background: var(--accent);
    padding: 8px 14px; border-radius: 8px; font-weight: 500;
  }
  header.site nav a.cta:hover { filter: brightness(1.1); }

  footer.site {
    padding: 32px 24px 48px; text-align: center;
    color: var(--muted); font-size: 13px;
    border-top: 1px solid var(--border);
    margin-top: 48px;
  }
  footer.site .links {
    display: flex; justify-content: center;
    gap: 6px 18px; flex-wrap: wrap;
    margin-bottom: 14px;
  }
  footer.site a { color: var(--muted); text-decoration: none; }
  footer.site a:hover { color: var(--text); }
  footer.site p { margin: 6px 0 0; max-width: 560px; margin-left: auto; margin-right: auto; }

  @media (max-width: 720px) {
    header.site {
      padding: 12px 16px;
      position: static;
    }
    header.site nav {
      width: 100%;
      gap: 4px 14px;
    }
    header.site nav a { font-size: 13px; }
    header.site nav a.cta {
      padding: 6px 12px; font-size: 13px;
    }
    footer.site { padding: 24px 16px 36px; }
  }
`;

export function marketingHeaderHtml(): string {
  return `<header class="site">
  <a class="brand" href="/">IBKR Gateway</a>
  <nav>
    <a href="/help/mcp">Connect Claude (MCP)</a>
    <a href="/help/paper-account">Paper accounts</a>
    <a href="/help/authenticator-app">Live setup</a>
    <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>
    <a class="cta" href="/console">Sign in</a>
  </nav>
</header>`;
}

export function marketingFooterHtml(): string {
  return `<footer class="site">
  <div class="links">
    <a href="/">Home</a>
    <a href="/help/mcp">MCP setup</a>
    <a href="/help/paper-account">Paper accounts</a>
    <a href="/help/authenticator-app">Live setup</a>
    <a href="/console">Console</a>
    <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>
  </div>
  <p>
    IBKR Gateway is an independent project. Not affiliated with
    Interactive Brokers.
  </p>
</footer>`;
}
