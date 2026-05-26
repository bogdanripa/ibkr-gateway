// Render the marketing pages (homepage + /help/*) to static .html
// files under dist/public/. The server picks these up at runtime via
// express.static, so a GET / is a plain file read — no per-request
// templating. The console SPA stays dynamic; this only covers the
// public marketing surface.
//
// Inputs:
//   PUBLIC_ORIGIN — optional, defaults to the production origin.
//                   Same default as src/config.ts so dev and prod
//                   produce identical output when nothing is set.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { authenticatorAppHtml } from "../src/help/authenticator-app.js";
import { contactHtml } from "../src/help/contact.js";
import { contactThanksHtml } from "../src/help/contact-thanks.js";
import { mcpHelpHtml } from "../src/help/mcp.js";
import { paperAccountHtml } from "../src/help/paper-account.js";
import { privacyHtml } from "../src/help/privacy.js";
import { termsHtml } from "../src/help/terms.js";
import { homeHtml } from "../src/home.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "dist", "public");

const origin = (process.env.PUBLIC_ORIGIN ?? "https://ibkr-gateway.bogdanripa.com").replace(/\/$/, "");

const pages: Array<{ path: string; html: string }> = [
  { path: "index.html", html: homeHtml(origin) },
  { path: "help/paper-account.html", html: paperAccountHtml() },
  { path: "help/authenticator-app.html", html: authenticatorAppHtml() },
  { path: "help/mcp.html", html: mcpHelpHtml() },
  { path: "terms.html", html: termsHtml() },
  { path: "privacy.html", html: privacyHtml() },
  { path: "contact.html", html: contactHtml() },
  { path: "contact-thanks.html", html: contactThanksHtml() },
];

for (const { path, html } of pages) {
  const full = join(OUT_DIR, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, html, "utf8");
  console.log(`wrote ${full} (${html.length} bytes)`);
}

console.log(`done. origin=${origin}`);
