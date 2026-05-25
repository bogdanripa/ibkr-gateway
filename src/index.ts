// Entry point. v1 wires up the Express app:
//   /console/api/*   — Firebase-authenticated console backend (api.ts)
//   /console         — single-page UI (ui.ts)
//   /healthz         — already served by Caddy ahead of us, but kept here
//                      for direct localhost checks
//
// Trading API endpoints (/v1/*) will be layered on in §11 step 7 once the
// Supervisor is in place.

import express from "express";
import { config } from "./config.js";
import { consoleApi } from "./console/api.js";
import { consoleHtml } from "./console/ui.js";

const app = express();
app.disable("x-powered-by");

// Console API.
app.use("/console/api", consoleApi);

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
