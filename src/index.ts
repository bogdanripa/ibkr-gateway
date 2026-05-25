// Entry point. v1 placeholder — wires up an Express app that serves
// /healthz on PORT (8080 by default). Caddy reverse-proxies HTTPS to here.
//
// The proxy + supervisor (§4) will be layered on top of this in later steps.

import express from "express";
import { config } from "./config.js";

const app = express();

app.get("/healthz", (_req, res) => {
  res.type("text").send("ibkr-gateway: app ok\n");
});

app.listen(config.port, () => {
  // Don't log credentials — ever. This logs only port + project id.
  console.log(
    `ibkr-gateway listening on :${config.port} (project=${config.projectId})`
  );
});
