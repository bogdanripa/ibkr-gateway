// Shared chrome (header, footer, base CSS, brand logo) for the public
// marketing surface: the homepage at "/" and the /help/* pages. Used
// by the OAuth consent page and the console too so the brand stays
// consistent across every entry point.
//
// Pure HTML strings — no JS, no build step. The pages still render
// in a single GET. The mobile menu is a CSS-only checkbox hack so we
// don't ship JS just to toggle a nav.

export const REPO_URL = "https://github.com/bogdanripa/ibkr-gateway";

// Brand mark: a rounded blue square with a white arrow piercing it —
// data flowing through a gateway. Inline SVG so it scales cleanly and
// costs nothing in HTTP. Caller sizes via the wrapping element.
export function marketingLogoSvg(size = 28): string {
  return `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
  <rect x="2" y="2" width="28" height="28" rx="7" fill="#5b8def"/>
  <path d="M9 16h11M15 11l5 5-5 5" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;
}

// Favicon as a data URI — same mark as marketingLogoSvg, inline so we
// don't need a separate static file. Goes in <head> on every page.
export const FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="7" fill="#5b8def"/><path d="M9 16h11M15 11l5 5-5 5" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
)}" />`;

// Variables + body + chrome (header + footer) + a couple of generic
// helpers (code, links, sticky header on desktop, burger nav on
// mobile). Page-specific styles (cards, grids, etc.) live in the
// individual page modules.
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
    display: inline-flex; align-items: center; gap: 10px;
    font-weight: 600; font-size: 16px; letter-spacing: 0.02em;
    color: var(--text); text-decoration: none;
    white-space: nowrap;
  }
  header.site .brand .logo { display: block; flex-shrink: 0; }
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

  /* Burger toggle — hidden on desktop, visible on mobile.
     Checkbox is visually hidden but stays focusable for keyboard nav. */
  header.site .nav-toggle {
    position: absolute; opacity: 0; pointer-events: none;
    width: 0; height: 0;
  }
  header.site .burger {
    display: none;
    width: 40px; height: 40px;
    align-items: center; justify-content: center;
    cursor: pointer; color: var(--text);
    border: 1px solid var(--border); border-radius: 8px;
    background: transparent;
  }
  header.site .burger:hover { background: var(--card); }
  header.site .burger svg { display: block; }
  header.site .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
  header.site .burger .icon-close { display: none; }
  header.site .nav-toggle:checked ~ .burger .icon-open { display: none; }
  header.site .nav-toggle:checked ~ .burger .icon-close { display: block; }
  header.site .nav-toggle:focus-visible ~ .burger {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }

  footer.site {
    padding: 32px 24px 48px; text-align: center;
    color: var(--muted); font-size: 13px;
    border-top: 1px solid var(--border);
    margin-top: 48px;
  }
  footer.site .footer-brand {
    display: inline-flex; align-items: center; gap: 8px;
    color: var(--text); text-decoration: none;
    font-weight: 600; font-size: 14px;
    margin-bottom: 12px;
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
    header.site .burger { display: inline-flex; }
    header.site nav {
      display: none;
      width: 100%; order: 3;
      flex-direction: column; align-items: stretch;
      gap: 2px;
      padding-top: 10px;
      border-top: 1px solid var(--border);
      margin-top: 8px;
    }
    header.site nav a {
      font-size: 15px;
      padding: 10px 6px;
      border-radius: 6px;
    }
    header.site nav a:hover { background: var(--card); }
    header.site nav a.cta {
      text-align: center; padding: 12px 14px; margin-top: 6px;
    }
    header.site .nav-toggle:checked ~ nav { display: flex; }
    footer.site { padding: 24px 16px 36px; }
  }
`;

export function marketingHeaderHtml(): string {
  return `<header class="site">
  <a class="brand" href="/">
    ${marketingLogoSvg(28)}
    <span>IBKR Gateway</span>
  </a>
  <input type="checkbox" id="nav-toggle" class="nav-toggle" aria-label="Toggle navigation" />
  <label for="nav-toggle" class="burger">
    <span class="sr-only">Menu</span>
    <svg class="icon-open" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>
    <svg class="icon-close" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
  </label>
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
  <a class="footer-brand" href="/">
    ${marketingLogoSvg(20)}
    <span>IBKR Gateway</span>
  </a>
  <div class="links">
    <a href="/">Home</a>
    <a href="/help/mcp">MCP setup</a>
    <a href="/help/paper-account">Paper accounts</a>
    <a href="/help/authenticator-app">Live setup</a>
    <a href="/console">Console</a>
    <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>
  </div>
  <div class="links">
    <a href="/terms">Terms of Use</a>
    <a href="/privacy">Privacy Policy</a>
  </div>
  <p>
    IBKR Gateway is an independent project. Not affiliated with
    Interactive Brokers.
  </p>
</footer>`;
}
