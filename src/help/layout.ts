// Shared chrome for the static help pages.
// Public — no auth required.

export interface HelpPage {
  title: string;       // <title> + h1 in the header
  bodyHtml: string;    // the main content (already-escaped HTML)
}

// Single shared stylesheet — matches src/console/ui.ts so the help
// pages and the console share a visual identity. Kept inline so the
// pages remain a single GET with no extra round trip.
const STYLE = `
  :root {
    --bg: #0e0f12;
    --fg: #e6e7ea;
    --muted: #888c94;
    --card: #15171c;
    --border: #2a2d35;
    --accent: #5a8df0;
    --warn: #d39654;
    --ok: #4fb87a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--fg);
  }
  header {
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
    display: flex; justify-content: space-between; align-items: center;
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 500; }
  header a { color: var(--accent); text-decoration: none; margin-left: 16px; font-size: 13px; }
  main { max-width: 760px; margin: 32px auto; padding: 0 24px 64px; }
  main h1 { font-size: 24px; font-weight: 600; margin: 0 0 24px; }
  main h2 { font-size: 17px; font-weight: 600; margin: 32px 0 8px; color: var(--fg); }
  main h3 { font-size: 15px; font-weight: 600; margin: 20px 0 6px; color: var(--fg); }
  main p { margin: 8px 0 12px; }
  main ul, main ol { margin: 8px 0 12px; padding-left: 24px; }
  main li { margin: 4px 0; }
  main a { color: var(--accent); }
  main code { background: var(--card); padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  main .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px 18px; margin: 16px 0; }
  main .note { border-left: 3px solid var(--warn); padding: 10px 14px; background: rgba(211,150,84,0.06); border-radius: 0 6px 6px 0; margin: 12px 0; }
  main .ok   { border-left: 3px solid var(--ok);   padding: 10px 14px; background: rgba(79,184,122,0.06); border-radius: 0 6px 6px 0; margin: 12px 0; }
  main .step { margin: 10px 0 14px; padding-left: 32px; position: relative; }
  main .step::before {
    content: counter(step);
    counter-increment: step;
    position: absolute; left: 0; top: 1px;
    width: 22px; height: 22px; line-height: 22px;
    background: var(--accent); color: #fff; border-radius: 50%;
    text-align: center; font-size: 12px; font-weight: 600;
  }
  main .steps { counter-reset: step; }
  main hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; }
  main .muted { color: var(--muted); font-size: 13px; }
`;

export function renderHelpPage(page: HelpPage): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${page.title} — IBKR Gateway</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>IBKR Gateway</h1>
  <nav>
    <a href="/help/paper-account">Paper accounts</a>
    <a href="/help/authenticator-app">Authenticator App</a>
    <a href="/help/mcp">Connect Claude (MCP)</a>
    <a href="/console">Console</a>
  </nav>
</header>
<main>
${page.bodyHtml}
</main>
</body>
</html>`;
}
