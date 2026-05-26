// Shared chrome for the static help pages.
// Public — no auth required.
//
// The header / footer / colour palette come from src/marketing.ts so
// the help pages stay visually identical to the homepage at "/". The
// page-specific styles below cover prose, cards, numbered steps and
// callouts — content-level concerns the homepage doesn't need.

import {
  FAVICON_LINK,
  MARKETING_CHROME_CSS,
  marketingFooterHtml,
  marketingHeaderHtml,
} from "../marketing.js";

export interface HelpPage {
  title: string;       // <title> + h1 in the page body
  bodyHtml: string;    // the main content (already-escaped HTML)
}

const HELP_CONTENT_CSS = `
  main { max-width: 760px; margin: 32px auto 0; padding: 0 24px 32px; }
  main h1 {
    font-size: 30px; font-weight: 700; margin: 16px 0 24px;
    letter-spacing: -0.02em; line-height: 1.15;
  }
  main h2 {
    font-size: 22px; font-weight: 600; margin: 36px 0 10px;
    letter-spacing: -0.01em;
  }
  main h3 { font-size: 16px; font-weight: 600; margin: 22px 0 6px; }
  main p { margin: 8px 0 12px; color: #d6d9de; }
  main ul, main ol { margin: 8px 0 12px; padding-left: 24px; color: #d6d9de; }
  main li { margin: 4px 0; }

  main .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 8px; padding: 16px 18px; margin: 16px 0;
    overflow-x: auto;
  }
  main .note {
    border-left: 3px solid var(--warn);
    padding: 10px 14px; background: rgba(211,150,84,0.08);
    border-radius: 0 6px 6px 0; margin: 14px 0;
  }
  main .ok {
    border-left: 3px solid var(--ok);
    padding: 10px 14px; background: rgba(74,222,128,0.08);
    border-radius: 0 6px 6px 0; margin: 14px 0;
  }
  main .step { margin: 10px 0 14px; padding-left: 36px; position: relative; }
  main .step::before {
    content: counter(step);
    counter-increment: step;
    position: absolute; left: 0; top: 1px;
    width: 24px; height: 24px; line-height: 24px;
    background: var(--accent); color: #fff; border-radius: 50%;
    text-align: center; font-size: 12px; font-weight: 600;
  }
  main .steps { counter-reset: step; }
  main hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; }
  main .muted { color: var(--muted); font-size: 13px; }

  /* Form primitives — used by /contact and any future help-shaped form. */
  main .field { margin: 16px 0; }
  main .field label {
    display: block; font-size: 13px; color: var(--muted);
    margin-bottom: 6px;
  }
  main .field input, main .field textarea {
    width: 100%; background: #1a1f25; color: var(--text);
    border: 1px solid var(--border); border-radius: 8px;
    padding: 10px 12px;
    font: inherit;
  }
  main .field input:focus, main .field textarea:focus {
    outline: none; border-color: var(--accent);
  }
  main .field textarea { min-height: 160px; resize: vertical; }
  main button.primary {
    background: var(--accent); color: #fff;
    border: 1px solid var(--accent); border-radius: 8px;
    padding: 11px 20px;
    font: inherit; font-weight: 500; cursor: pointer;
  }
  main button.primary:hover { filter: brightness(1.1); }
  main .honeypot {
    position: absolute; left: -9999px; top: -9999px;
    width: 1px; height: 1px; overflow: hidden;
  }

  @media (max-width: 720px) {
    main { padding: 0 16px 24px; margin-top: 20px; }
    main h1 { font-size: 26px; }
    main h2 { font-size: 19px; margin-top: 28px; }
    main h3 { font-size: 15px; }
    main .card { padding: 14px; }
    main .step { padding-left: 32px; }
    main .step::before { width: 22px; height: 22px; line-height: 22px; }
  }
`;

export function renderHelpPage(page: HelpPage): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${page.title} — IBKR Gateway</title>
<meta name="robots" content="index, follow" />
${FAVICON_LINK}
<style>
${MARKETING_CHROME_CSS}
${HELP_CONTENT_CSS}
</style>
</head>
<body>
${marketingHeaderHtml()}
<main>
${page.bodyHtml}
</main>
${marketingFooterHtml()}
</body>
</html>`;
}
