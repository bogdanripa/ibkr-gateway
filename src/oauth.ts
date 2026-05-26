// OAuth 2.1 Authorization Server for MCP clients.
//
// Why this exists
// ---------------
// Until now MCP callers authenticated with a raw `ibkr_…` API key.
// That works for scripts but is hostile to humans wiring up
// Claude.ai, Cursor, etc., AND it gives every key full write
// capability with no scope choice. This module implements the
// OAuth 2.1 flow expected by MCP-compatible hosts:
//
//   1. Client (Claude) discovers our endpoints via
//      /.well-known/oauth-protected-resource (on the MCP server)
//      and /.well-known/oauth-authorization-server (here).
//   2. Client self-registers via /oauth/register (RFC 7591). The
//      registration is anonymous — the human-user binding happens
//      at /authorize.
//   3. Client redirects the user's browser to /oauth/authorize
//      with PKCE parameters. We:
//        · require a signed-in Firebase user (same Google login
//          the console uses),
//        · render a consent screen letting the human pick which
//          IBKR connection to expose and at what scope
//          ("read" or "write"),
//        · on Approve, mint a short-lived auth code bound to
//          (user, connection, scope) and 302 back to the client.
//      If the user has zero connections, the consent screen
//      replaces the picker with a CTA pointing to /console so
//      they can set one up first.
//   4. Client exchanges the code at /oauth/token (with the PKCE
//      verifier) for an opaque access token. The token carries
//      (connection_id, scope) — that's the binding the MCP
//      middleware reads back later.
//
// Scope semantics
// ---------------
// - "read"   — tools tagged `mutating: false` in src/mcp.ts.
//              Tools tagged mutating disappear from tools/list and
//              return -32004 if invoked directly.
// - "write"  — full access. Equivalent to the legacy API-key path.
//
// Token storage
// -------------
// Tokens are stored hashed (sha256) with an 8-char prefix index,
// matching the existing api-key scheme. The raw token leaves the
// server exactly once — in the /oauth/token response body.

import { Router, type Request, type Response } from "express";
import express from "express";
import admin from "firebase-admin";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { FieldValue, Timestamp } from "@google-cloud/firestore";
import { config } from "./config.js";
import {
  oauthClientsCol,
  oauthCodesCol,
  oauthTokensCol,
  connectionsCol,
  accountsCol,
  type OAuthTokenDoc,
} from "./firestore.js";
import { logError } from "./logging.js";
import { FAVICON_LINK, marketingLogoSvg } from "./marketing.js";

const CODE_TTL_SECONDS = 60;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const TOKEN_BODY_BYTES = 24; // 32 base64url chars
const TOKEN_PREFIX = "ibkr_oat_";
const TOKEN_LOOKUP_PREFIX_LEN = 8;

const SUPPORTED_SCOPES = ["read", "write"] as const;
type Scope = (typeof SUPPORTED_SCOPES)[number];
function isScope(v: unknown): v is Scope {
  return v === "read" || v === "write";
}

// Ensure Firebase admin is initialised (same as src/console/auth.ts).
if (!admin.apps.length) {
  admin.initializeApp({ projectId: config.projectId });
}

export const oauth: Router = Router();

// ---------------------------------------------------------------------------
// Discovery metadata.
// ---------------------------------------------------------------------------
//
// RFC 8414 says these should be at the path /.well-known/oauth-authorization-server
// rooted at the issuer. Issuer == our public origin.

// Protected-resource metadata (RFC 9728). Tells MCP clients which
// Authorization Server is responsible for this resource. We host
// both AS and RS on the same origin, so the value is just us.
oauth.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: `${config.publicOrigin}/mcp`,
    authorization_servers: [config.publicOrigin],
    scopes_supported: ["read", "write"],
    bearer_methods_supported: ["header"],
  });
});

oauth.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: config.publicOrigin,
    authorization_endpoint: `${config.publicOrigin}/oauth/authorize`,
    token_endpoint: `${config.publicOrigin}/oauth/token`,
    registration_endpoint: `${config.publicOrigin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["read", "write"],
  });
});

// ---------------------------------------------------------------------------
// /oauth/register — Dynamic Client Registration (RFC 7591).
// ---------------------------------------------------------------------------
//
// Anyone can register; the value of registration is just to give us a
// stable client_id to log against. We require redirect_uris because
// PKCE clients still need them.

oauth.post("/oauth/register", express.json(), async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      client_name?: unknown;
      redirect_uris?: unknown;
    };
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === "string" && u.length > 0)
      : [];
    if (redirectUris.length === 0) {
      res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be a non-empty array of strings" });
      return;
    }
    const clientName = typeof body.client_name === "string" && body.client_name.trim()
      ? body.client_name.trim().slice(0, 120)
      : "Unnamed MCP client";

    const ref = await oauthClientsCol.add({
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      created_at: FieldValue.serverTimestamp() as unknown as Timestamp,
    });

    res.status(201).json({
      client_id: ref.id,
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    });
  } catch (err) {
    logError({
      source: "console-api",
      code: "OAUTH_REGISTER_FAILED",
      error: err,
      context: { path: req.path },
    }).catch(() => undefined);
    res.status(500).json({ error: "server_error", error_description: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// /oauth/authorize — HTML consent screen.
// ---------------------------------------------------------------------------
//
// We respond with an HTML page that handles Firebase Google sign-in
// client-side and then renders the consent UI. The consent UI calls
// /oauth/consent (XHR with Firebase Bearer) to make the actual
// decision, which returns the absolute redirect URL the page then
// 302s to. The browser does the final redirect.

oauth.get("/oauth/authorize", async (req, res) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const params = {
      client_id: q.client_id ?? "",
      redirect_uri: q.redirect_uri ?? "",
      response_type: q.response_type ?? "code",
      scope: q.scope ?? "read",
      state: q.state ?? "",
      code_challenge: q.code_challenge ?? "",
      code_challenge_method: q.code_challenge_method ?? "S256",
    };

    if (params.response_type !== "code") {
      res.status(400).send("response_type must be 'code'");
      return;
    }
    if (params.code_challenge_method !== "S256") {
      res.status(400).send("code_challenge_method must be S256");
      return;
    }
    if (!params.client_id || !params.redirect_uri || !params.code_challenge) {
      res.status(400).send("missing client_id, redirect_uri, or code_challenge");
      return;
    }

    // Validate the client + redirect_uri up front so we don't render a
    // consent page for a phantom client.
    const clientSnap = await oauthClientsCol.doc(params.client_id).get();
    if (!clientSnap.exists) {
      res.status(400).send("unknown client_id");
      return;
    }
    const client = clientSnap.data()!;
    if (!client.redirect_uris.includes(params.redirect_uri)) {
      res.status(400).send("redirect_uri not registered for this client");
      return;
    }

    res.type("html").send(consentPageHtml(params, client.client_name));
  } catch (err) {
    logError({
      source: "console-api",
      code: "OAUTH_AUTHORIZE_FAILED",
      error: err,
      context: { path: req.path },
    }).catch(() => undefined);
    res.status(500).send("server error");
  }
});

// ---------------------------------------------------------------------------
// /oauth/consent — XHR endpoint posted by the consent page.
// ---------------------------------------------------------------------------
//
// Auth: Firebase ID token in Authorization: Bearer …, same as the
// console API. Verifies user, looks up the requested client + the
// user's connections, validates the user's selection, mints a code,
// and returns the absolute redirect URL.

oauth.post("/oauth/consent", express.json(), async (req: Request, res: Response) => {
  // Firebase-auth gate — inline minimal version (don't import the
  // console middleware to avoid cycles).
  const header = req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: "missing bearer token" });
    return;
  }
  let decoded: admin.auth.DecodedIdToken;
  try {
    decoded = await admin.auth().verifyIdToken(match[1]!);
  } catch (err) {
    res.status(401).json({ error: "invalid token", detail: (err as Error).message });
    return;
  }
  if (!decoded.email) {
    res.status(401).json({ error: "token has no email claim" });
    return;
  }
  // Find the account doc.
  const acctSnap = await accountsCol.where("firebase_uid", "==", decoded.uid).limit(1).get();
  if (acctSnap.empty) {
    res.status(403).json({ error: "no account record yet — visit /console first" });
    return;
  }
  const accountId = acctSnap.docs[0]!.id;

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const decision = body.decision === "approve" ? "approve" : "deny";

    // Echo of the original authorize params (the page round-trips them).
    const clientId = String(body.client_id ?? "");
    const redirectUri = String(body.redirect_uri ?? "");
    const state = String(body.state ?? "");
    const codeChallenge = String(body.code_challenge ?? "");
    const codeChallengeMethod = String(body.code_challenge_method ?? "S256");
    const requestedScope = String(body.requested_scope ?? "read");

    if (!clientId || !redirectUri || !codeChallenge) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    if (codeChallengeMethod !== "S256") {
      res.status(400).json({ error: "unsupported_code_challenge_method" });
      return;
    }

    // Re-validate client + redirect.
    const clientSnap = await oauthClientsCol.doc(clientId).get();
    if (!clientSnap.exists || !clientSnap.data()!.redirect_uris.includes(redirectUri)) {
      res.status(400).json({ error: "invalid_client_or_redirect" });
      return;
    }

    if (decision === "deny") {
      const url = new URL(redirectUri);
      url.searchParams.set("error", "access_denied");
      if (state) url.searchParams.set("state", state);
      res.json({ redirect: url.toString() });
      return;
    }

    // Approve path: the user must have selected a connection + scope.
    const connectionId = String(body.connection_id ?? "");
    const grantedScope = body.scope;
    if (!connectionId || !isScope(grantedScope)) {
      res.status(400).json({ error: "missing connection_id or scope" });
      return;
    }
    // Granted scope can't exceed requested scope (defence in depth).
    if (requestedScope === "read" && grantedScope === "write") {
      res.status(400).json({ error: "granted scope exceeds requested" });
      return;
    }
    // Verify the connection belongs to this account.
    const connSnap = await connectionsCol.doc(connectionId).get();
    if (!connSnap.exists || connSnap.data()!.account_id !== accountId) {
      res.status(403).json({ error: "connection not found" });
      return;
    }

    // Mint code.
    const code = `oac_${randomBytes(24).toString("base64url")}`;
    const expiresAt = Timestamp.fromMillis(Date.now() + CODE_TTL_SECONDS * 1000);
    await oauthCodesCol.doc(code).set({
      client_id: clientId,
      redirect_uri: redirectUri,
      account_id: accountId,
      connection_id: connectionId,
      scope: grantedScope,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      expires_at: expiresAt,
      used_at: null,
    });

    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    res.json({ redirect: url.toString() });
  } catch (err) {
    logError({
      source: "console-api",
      code: "OAUTH_CONSENT_FAILED",
      error: err,
      context: { account_id: accountId },
    }).catch(() => undefined);
    res.status(500).json({ error: "server_error", detail: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// /oauth/consent-info — XHR called by the consent page to fetch what
// to render (account email, connections list, client name).
// ---------------------------------------------------------------------------

oauth.get("/oauth/consent-info", async (req, res) => {
  const header = req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: "missing bearer token" });
    return;
  }
  let decoded: admin.auth.DecodedIdToken;
  try {
    decoded = await admin.auth().verifyIdToken(match[1]!);
  } catch (err) {
    res.status(401).json({ error: "invalid token", detail: (err as Error).message });
    return;
  }
  const acctSnap = await accountsCol.where("firebase_uid", "==", decoded.uid).limit(1).get();
  if (acctSnap.empty) {
    res.json({ email: decoded.email ?? null, connections: [] });
    return;
  }
  const accountId = acctSnap.docs[0]!.id;
  const clientId = String(req.query.client_id ?? "");
  const clientSnap = clientId ? await oauthClientsCol.doc(clientId).get() : null;
  const client = clientSnap?.exists ? clientSnap.data() : null;

  const connSnap = await connectionsCol.where("account_id", "==", accountId).get();
  const connections = connSnap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      label: data.label,
      mode: data.mode,
      ibkr_account_id: data.ibkr_account_id,
      credential_status: data.credential_status,
    };
  });

  res.json({
    email: decoded.email ?? null,
    client_name: client?.client_name ?? null,
    connections,
  });
});

// ---------------------------------------------------------------------------
// /oauth/token — exchange auth code for access token.
// ---------------------------------------------------------------------------

oauth.post("/oauth/token", express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const grantType = String(body.grant_type ?? "");
    if (grantType !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }
    const code = String(body.code ?? "");
    const codeVerifier = String(body.code_verifier ?? "");
    const clientId = String(body.client_id ?? "");
    const redirectUri = String(body.redirect_uri ?? "");

    if (!code || !codeVerifier || !clientId || !redirectUri) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    const codeRef = oauthCodesCol.doc(code);
    const codeSnap = await codeRef.get();
    if (!codeSnap.exists) {
      res.status(400).json({ error: "invalid_grant", error_description: "unknown code" });
      return;
    }
    const codeDoc = codeSnap.data()!;
    if (codeDoc.used_at) {
      // Single-use. Revoke any tokens already issued from a replay attempt.
      res.status(400).json({ error: "invalid_grant", error_description: "code already used" });
      return;
    }
    if (codeDoc.expires_at.toMillis() < Date.now()) {
      res.status(400).json({ error: "invalid_grant", error_description: "code expired" });
      return;
    }
    if (codeDoc.client_id !== clientId) {
      res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch" });
      return;
    }
    if (codeDoc.redirect_uri !== redirectUri) {
      res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
      return;
    }

    // PKCE verification: BASE64URL(SHA256(verifier)) == challenge.
    const computed = createHash("sha256").update(codeVerifier).digest("base64url");
    if (!constantTimeStringEquals(computed, codeDoc.code_challenge)) {
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }

    // Mint token.
    const rawBody = randomBytes(TOKEN_BODY_BYTES).toString("base64url");
    const raw = `${TOKEN_PREFIX}${rawBody}`;
    const tokenHash = createHash("sha256").update(raw).digest("base64");
    const tokenPrefix = rawBody.slice(0, TOKEN_LOOKUP_PREFIX_LEN);

    const now = Date.now();
    const expiresAt = Timestamp.fromMillis(now + TOKEN_TTL_SECONDS * 1000);
    await oauthTokensCol.add({
      client_id: codeDoc.client_id,
      account_id: codeDoc.account_id,
      connection_id: codeDoc.connection_id,
      scope: codeDoc.scope,
      token_prefix: tokenPrefix,
      token_hash: tokenHash,
      created_at: Timestamp.fromMillis(now),
      expires_at: expiresAt,
      last_used_at: null,
      revoked_at: null,
    });

    // Burn the code.
    await codeRef.update({ used_at: FieldValue.serverTimestamp() });

    res.json({
      access_token: raw,
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SECONDS,
      scope: codeDoc.scope,
    });
  } catch (err) {
    logError({
      source: "console-api",
      code: "OAUTH_TOKEN_FAILED",
      error: err,
      context: { path: req.path },
    }).catch(() => undefined);
    res.status(500).json({ error: "server_error", error_description: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Token resolution — exported for the MCP middleware.
// ---------------------------------------------------------------------------

export interface ResolvedOAuthToken {
  id: string;
  connection_id: string;
  account_id: string;
  scope: Scope;
  client_id: string;
}

export async function findConnectionByOAuthToken(raw: string): Promise<ResolvedOAuthToken | null> {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const body = raw.slice(TOKEN_PREFIX.length);
  if (body.length < TOKEN_LOOKUP_PREFIX_LEN) return null;
  const prefix = body.slice(0, TOKEN_LOOKUP_PREFIX_LEN);

  const snap = await oauthTokensCol.where("token_prefix", "==", prefix).get();
  if (snap.empty) return null;
  const candidateHash = createHash("sha256").update(raw).digest("base64");

  let match: { id: string; doc: OAuthTokenDoc } | null = null;
  for (const d of snap.docs) {
    const data = d.data();
    if (data.revoked_at) continue;
    if (data.expires_at.toMillis() < Date.now()) continue;
    if (!constantTimeStringEquals(data.token_hash, candidateHash)) continue;
    match = { id: d.id, doc: data };
    break;
  }
  if (!match) return null;

  oauthTokensCol
    .doc(match.id)
    .update({ last_used_at: FieldValue.serverTimestamp() })
    .catch(() => undefined);

  return {
    id: match.id,
    connection_id: match.doc.connection_id,
    account_id: match.doc.account_id,
    scope: match.doc.scope,
    client_id: match.doc.client_id,
  };
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function constantTimeStringEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  scope: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
}

function consentPageHtml(p: AuthorizeParams, clientName: string): string {
  // Server-rendered HTML. The page loads Firebase JS SDK, signs the
  // user in (Google popup), then calls /oauth/consent-info to render
  // the connection picker. On Approve, posts /oauth/consent and
  // navigates to the returned redirect URL.
  const json = JSON.stringify({
    params: p,
    clientName,
    firebase: firebasePublicConfig(),
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Authorize ${escapeHtml(clientName)} — IBKR Gateway</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
${FAVICON_LINK}
<style>
  :root {
    --bg: #0b0d10; --card: #14181d; --border: #2a3038;
    --text: #e8eaed; --muted: #9aa3ad; --accent: #5b8def;
    --ok: #4ade80; --bad: #f87171; --warn: #fbbf24;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; background:
      radial-gradient(800px 400px at 50% -10%, rgba(91, 141, 239, 0.18), transparent 60%),
      var(--bg);
    color: var(--text);
    font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    display: flex; flex-direction: column; align-items: center;
    padding: 32px 20px;
  }
  .brand {
    display: inline-flex; align-items: center; gap: 10px;
    margin-bottom: 24px;
    font-weight: 600; font-size: 16px; letter-spacing: 0.02em;
    color: var(--text); text-decoration: none;
  }
  .brand .logo { display: block; flex-shrink: 0; }
  .card-wrap { width: 100%; max-width: 460px; display: flex; justify-content: center; }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    padding: 28px; max-width: 460px; width: 100%;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .muted { color: var(--muted); }
  .field { margin-top: 20px; }
  .field-label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; }
  select, button {
    background: #1a1f25; color: var(--text); border: 1px solid var(--border); border-radius: 8px;
    padding: 10px 12px; font: inherit; width: 100%;
  }
  button { cursor: pointer; }
  button:disabled { cursor: not-allowed; opacity: 0.55; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 500; }
  button.primary:hover { filter: brightness(1.1); }
  button.subtle { background: transparent; }
  .row { display: flex; gap: 12px; margin-top: 24px; }
  .row > * { flex: 1; }
  .scope-toggle { display: flex; gap: 8px; }
  .scope-toggle label {
    flex: 1; padding: 12px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer;
    text-align: center; background: #1a1f25;
  }
  .scope-toggle input { display: none; }
  .scope-toggle input:checked + span { color: var(--accent); font-weight: 600; }
  .scope-toggle label:has(input:checked) { border-color: var(--accent); background: #182335; }
  .bad { color: var(--bad); }
  .ok { color: var(--ok); }
  .signed-as { font-size: 12px; color: var(--muted); margin-top: 16px; }
  .empty-state {
    background: #1a1f25; border: 1px dashed var(--border); border-radius: 8px;
    padding: 16px; text-align: center;
  }
  a { color: var(--accent); }
</style>
</head>
<body>
<a class="brand" href="/">
  ${marketingLogoSvg(28)}
  <span>IBKR Gateway</span>
</a>
<div class="card-wrap">
  <div class="card" id="card">
    <h1>Authorize access</h1>
    <p class="muted" id="intro">Loading…</p>
    <div id="content"></div>
  </div>
</div>

<script type="module">
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";

const CFG = ${json};
const app = initializeApp(CFG.firebase);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

const card = document.getElementById("card");
const intro = document.getElementById("intro");
const content = document.getElementById("content");

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"
  })[c]);
}

function renderSignedOut() {
  intro.textContent = "Sign in to grant " + (CFG.clientName || "this client") + " access to your IBKR connection.";
  content.innerHTML = '<div class="field"><button class="primary" id="signin">Sign in with Google</button></div>';
  document.getElementById("signin").addEventListener("click", () => signInWithPopup(auth, provider));
}

async function renderSignedIn(user) {
  intro.textContent = (CFG.clientName || "An MCP client") + " is requesting access to your IBKR gateway.";
  content.innerHTML = '<p class="muted">Loading your connections…</p>';

  let info;
  try {
    const tok = await user.getIdToken();
    const r = await fetch("/oauth/consent-info?client_id=" + encodeURIComponent(CFG.params.client_id), {
      headers: { Authorization: "Bearer " + tok },
    });
    info = await r.json();
    if (!r.ok) throw new Error(info.detail || info.error || ("HTTP " + r.status));
  } catch (e) {
    content.innerHTML = '<p class="bad">Could not load your account: ' + escapeHtml(e.message) + '</p>';
    return;
  }

  const valid = info.connections.filter((c) => c.credential_status === "valid");
  if (info.connections.length === 0) {
    content.innerHTML = \`
      <div class="empty-state">
        <p>You don't have any IBKR connections yet.</p>
        <p class="muted">Add one in the console, then come back to this page.</p>
        <p style="margin-top:14px;"><a href="/console" target="_blank">Open the console →</a></p>
      </div>
      <p class="signed-as">Signed in as \${escapeHtml(info.email)} · <a id="so" href="#">sign out</a></p>
    \`;
    document.getElementById("so").addEventListener("click", (e) => { e.preventDefault(); signOut(auth); });
    return;
  }

  const opts = info.connections.map((c) => {
    const dis = c.credential_status === "valid" ? "" : " disabled";
    const tag = c.credential_status === "valid" ? "" : " (" + c.credential_status + ")";
    const label = (c.label || c.ibkr_account_id || c.id) + " · " + c.mode + tag;
    return '<option value="' + escapeHtml(c.id) + '"' + dis + '>' + escapeHtml(label) + '</option>';
  }).join("");

  const requested = CFG.params.scope || "read";
  // If the client requested "read" only, lock the toggle to read.
  const writeDisabled = requested === "read" ? "disabled" : "";

  content.innerHTML = \`
    <div class="field">
      <label class="field-label">Connection</label>
      <select id="conn">\${opts}</select>
    </div>
    <div class="field">
      <label class="field-label">Access scope</label>
      <div class="scope-toggle">
        <label><input type="radio" name="scope" value="read" checked /><span>Read-only</span></label>
        <label><input type="radio" name="scope" value="write" \${writeDisabled} /><span>Read &amp; write</span></label>
      </div>
      <p class="muted" style="font-size:12px; margin-top:8px;">
        Read-only blocks placing or cancelling orders. \${writeDisabled ? "This client requested read-only." : ""}
      </p>
    </div>
    <div class="row">
      <button class="subtle" id="deny">Deny</button>
      <button class="primary" id="approve">Approve</button>
    </div>
    <p class="signed-as">Signed in as \${escapeHtml(info.email)} · <a id="so" href="#">sign out</a></p>
  \`;
  document.getElementById("so").addEventListener("click", (e) => { e.preventDefault(); signOut(auth); });

  const approveBtn = document.getElementById("approve");
  const denyBtn = document.getElementById("deny");
  const approveLabel = approveBtn.textContent;
  const denyLabel = denyBtn.textContent;

  const setBusy = (which) => {
    approveBtn.disabled = true;
    denyBtn.disabled = true;
    if (which === "approve") approveBtn.textContent = "Authorizing…";
    else denyBtn.textContent = "Denying…";
  };
  const clearBusy = () => {
    approveBtn.disabled = false;
    denyBtn.disabled = false;
    approveBtn.textContent = approveLabel;
    denyBtn.textContent = denyLabel;
  };

  const submit = async (decision) => {
    setBusy(decision);
    try {
      const connId = document.getElementById("conn").value;
      const scope = document.querySelector('input[name="scope"]:checked').value;
      const tok = await user.getIdToken();
      const r = await fetch("/oauth/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
        body: JSON.stringify({
          decision,
          client_id: CFG.params.client_id,
          redirect_uri: CFG.params.redirect_uri,
          state: CFG.params.state,
          code_challenge: CFG.params.code_challenge,
          code_challenge_method: CFG.params.code_challenge_method,
          requested_scope: CFG.params.scope,
          connection_id: connId,
          scope,
        }),
      });
      const out = await r.json();
      if (!r.ok) {
        content.innerHTML = '<p class="bad">' + escapeHtml(out.error || ("HTTP " + r.status)) + '</p>';
        return;
      }
      // Keep the buttons in their busy state during the redirect — the
      // browser is about to navigate away and re-enabling them would
      // just flash before the page unloads.
      window.location.href = out.redirect;
    } catch (e) {
      clearBusy();
      content.innerHTML = '<p class="bad">' + escapeHtml(e.message || String(e)) + '</p>';
    }
  };
  approveBtn.addEventListener("click", () => submit("approve"));
  denyBtn.addEventListener("click", () => submit("deny"));
}

onAuthStateChanged(auth, (user) => {
  if (user) renderSignedIn(user); else renderSignedOut();
});
</script>
</body>
</html>`;
}

function firebasePublicConfig(): Record<string, string> {
  // Same env vars the console uses (see src/console/firebase-config.ts).
  // Read them inline here to avoid importing the console module.
  const get = (k: string): string => process.env[k] ?? "";
  return {
    apiKey: get("FIREBASE_API_KEY"),
    authDomain: get("FIREBASE_AUTH_DOMAIN"),
    projectId: get("FIREBASE_PROJECT_ID"),
    storageBucket: get("FIREBASE_STORAGE_BUCKET"),
    messagingSenderId: get("FIREBASE_MESSAGING_SENDER_ID"),
    appId: get("FIREBASE_APP_ID"),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] ?? c));
}
