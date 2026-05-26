// Entry point. v1 wires up the Express app:
//   /console/api/*   — Firebase-authenticated console backend (api.ts)
//   /console         — single-page UI (ui.ts)
//   /help/*          — public static help pages (no auth)
//   /mcp             — Model Context Protocol server (bearer-key auth)
//   /healthz         — already served by Caddy ahead of us, but kept here
//                      for direct localhost checks

import express from "express";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { consoleApi } from "./console/api.js";
import { consoleHtml } from "./console/ui.js";
import { homeHtml } from "./home.js";
import { paperAccountHtml } from "./help/paper-account.js";
import { authenticatorAppHtml } from "./help/authenticator-app.js";
import { mcpHelpHtml } from "./help/mcp.js";
import { mcp } from "./mcp.js";
import { oauth } from "./oauth.js";

const STATIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "public");

const app = express();
app.disable("x-powered-by");

// Console API.
app.use("/console/api", consoleApi);

// OAuth 2.1 Authorization Server for MCP clients. Endpoints live at
// /.well-known/oauth-authorization-server (discovery), /oauth/* (flow).
app.use("/", oauth);

// MCP server (accepts OAuth Bearer or legacy ibkr_ API key; see src/mcp.ts).
app.use("/mcp", mcp);

// Public marketing pages (homepage + /help/*) are pre-rendered to
// static HTML by `npm run build` (see scripts/build-static.ts). Serve
// them straight from disk so a GET / is a single file read. The
// dynamic handlers below only fire as a fallback for dev — they let
// `npm run dev` work without running the static build first.
app.use(express.static(STATIC_DIR, { extensions: ["html"], index: "index.html" }));

app.get("/help/paper-account", (_req, res) => {
  res.type("html").send(paperAccountHtml());
});
app.get("/help/authenticator-app", (_req, res) => {
  res.type("html").send(authenticatorAppHtml());
});
app.get("/help/mcp", (_req, res) => {
  res.type("html").send(mcpHelpHtml());
});
app.get("/help", (_req, res) => res.redirect("/help/paper-account"));

app.get("/", (_req, res) => {
  res.type("html").send(homeHtml(config.publicOrigin));
});

// Console SPA — single HTML on /console*.
app.get(["/console", "/console/*splat"], (_req, res) => {
  res.type("html").send(consoleHtml());
});

// Local healthcheck (Caddy serves the public one).
app.get("/healthz", (_req, res) => {
  res.type("text").send("ibkr-gateway: app ok\n");
});

app.listen(config.port, () => {
  console.log(
    `ibkr-gateway listening on :${config.port} (project=${config.projectId})`
  );
});

// Never let an async error in a request handler take the whole process down.
import { logError } from "./logging.js";
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
  logError({ source: "unhandled", code: "UNHANDLED_REJECTION", error: reason }).catch(() => undefined);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
  logError({ source: "unhandled", code: "UNCAUGHT_EXCEPTION", error: err }).catch(() => undefined);
});
