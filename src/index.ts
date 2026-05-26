// Entry point. v1 wires up the Express app:
//   /console/api/*   — Firebase-authenticated console backend (api.ts)
//   /console         — single-page UI (ui.ts)
//   /help/*          — public static help pages (no auth)
//   /healthz         — already served by Caddy ahead of us, but kept here
//                      for direct localhost checks
//
// Trading API endpoints (/v1/*) will be layered on in §11 step 7 once the
// Supervisor is in place.

import express from "express";
import { config } from "./config.js";
import { consoleApi } from "./console/api.js";
import { consoleHtml } from "./console/ui.js";
import { paperAccountHtml } from "./help/paper-account.js";
import { authenticatorAppHtml } from "./help/authenticator-app.js";

const app = express();
app.disable("x-powered-by");

// Console API.
app.use("/console/api", consoleApi);

// Public help pages (must be registered BEFORE the /* fallback that
// serves the SPA, otherwise the SPA would shadow them).
app.get("/help/paper-account", (_req, res) => {
  res.type("html").send(paperAccountHtml());
});
app.get("/help/authenticator-app", (_req, res) => {
  res.type("html").send(authenticatorAppHtml());
});
app.get("/help", (_req, res) => res.redirect("/help/paper-account"));

// Console UI: serve the single HTML on / and on /console*.
app.get(["/", "/console", "/console/*splat"], (_req, res) => {
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
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});
