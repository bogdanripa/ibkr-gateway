// Console SPA — single HTML page, Firebase JS SDK from CDN, vanilla JS.
// Served from /console by src/index.ts.

import { firebaseConfig } from "./firebase-config.js";

export function consoleHtml(): string {
  // The firebaseConfig is public (client-side config; see firebase-config.ts).
  // Inlining it is safe and avoids an extra round trip.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>IBKR Gateway — Console</title>
<style>
  :root {
    --bg: #0e0f12;
    --fg: #e6e7ea;
    --muted: #888c94;
    --card: #15171c;
    --border: #2a2d35;
    --accent: #5a8df0;
    --danger: #d35454;
    --warn: #d39654;
    --ok: #4fb87a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--fg);
  }
  header {
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 500; }
  header .who { color: var(--muted); font-size: 13px; }
  header .who button { margin-left: 8px; }
  main { max-width: 880px; margin: 24px auto; padding: 0 24px; }
  h2 { font-size: 14px; font-weight: 500; color: var(--muted); margin: 24px 0 8px; text-transform: uppercase; letter-spacing: 0.05em; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  .card.conn { padding: 0; }
  .card.conn .conn-head { padding: 16px; display: flex; justify-content: space-between; align-items: center; }
  .card.conn .conn-body { padding: 0 16px 16px; border-top: 1px solid var(--border); }
  .conn-title { font-weight: 500; }
  .badge { display: inline-block; padding: 2px 8px; font-size: 12px; border-radius: 4px; background: #2a2d35; color: var(--muted); margin-left: 8px; }
  .badge.ok { background: rgba(79,184,122,0.15); color: var(--ok); }
  .badge.warn { background: rgba(211,150,84,0.15); color: var(--warn); }
  .badge.bad { background: rgba(211,84,84,0.15); color: var(--danger); }
  button {
    background: var(--accent);
    color: white;
    border: 1px solid transparent;
    padding: 6px 12px;
    border-radius: 6px;
    font: inherit;
    line-height: 1.2;
    cursor: pointer;
    white-space: nowrap;
  }
  button.ghost { background: transparent; color: var(--fg); border-color: var(--border); }
  button.danger { background: var(--danger); }
  button:disabled { opacity: 0.6; cursor: default; }
  .spinner {
    display: inline-block;
    width: 12px; height: 12px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    vertical-align: -2px;
    margin-right: 6px;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  input, textarea {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    font: inherit;
    width: 100%;
  }
  label { display: block; margin: 8px 0 4px; color: var(--muted); font-size: 13px; }
  .row { display: flex; gap: 8px; align-items: center; }
  .row > * { flex: 1; }
  .row > button { flex: 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; }
  code { background: var(--bg); padding: 2px 6px; border-radius: 4px; font-size: 12px; }
  .raw-key { background: #2a2210; border: 1px solid var(--warn); padding: 12px; border-radius: 6px; margin: 12px 0; word-break: break-all; }
  .raw-key strong { color: var(--warn); }
  .muted { color: var(--muted); }
  .signin { display: flex; justify-content: center; padding: 80px 0; }
  .err { color: var(--danger); margin: 8px 0; white-space: pre-wrap; }
  .empty { color: var(--muted); padding: 16px; text-align: center; }
</style>
</head>
<body>

<header>
  <h1>IBKR Gateway</h1>
  <div class="who" id="who"></div>
</header>

<main id="app">
  <div class="signin">
    <div style="text-align:center;">
      <button id="signin-btn">Sign in with Google</button>
      <p style="margin-top:24px;color:var(--muted);font-size:13px;">
        First time here? Read
        <a href="/help/paper-account" style="color:var(--accent);">how paper accounts work</a>
        before connecting.
      </p>
    </div>
  </div>
</main>

<script type="module">
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";

const firebaseConfig = ${JSON.stringify(firebaseConfig, null, 2)};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

const $ = (sel) => document.querySelector(sel);
const appEl = $("#app");
const whoEl = $("#who");

document.getElementById("signin-btn").addEventListener("click", () => signInWithPopup(auth, provider));

let currentUser = null;
let currentToken = null;

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user) {
    whoEl.textContent = "";
    renderSignin();
    return;
  }
  currentToken = await user.getIdToken();
  whoEl.innerHTML = \`\${user.email} <button class="ghost" id="signout">sign out</button>\`;
  document.getElementById("signout").addEventListener("click", () => signOut(auth));
  renderApp();
});

async function api(method, path, body) {
  const resp = await fetch("/console/api" + path, {
    method,
    headers: {
      "Authorization": "Bearer " + currentToken,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(\`\${resp.status}: \${txt}\`);
  }
  return resp.json();
}

function renderSignin() {
  appEl.innerHTML = '<div class="signin"><button id="signin-btn">Sign in with Google</button></div>';
  document.getElementById("signin-btn").addEventListener("click", () => signInWithPopup(auth, provider));
}

async function renderApp() {
  appEl.innerHTML = '<div class="muted">Loading…</div>';
  try {
    const me = await api("GET", "/me");
    const { connections } = await api("GET", "/connections");
    renderDashboard(me, connections);
  } catch (err) {
    appEl.innerHTML = '<div class="err">' + err.message + '</div>';
  }
}

function badge(status) {
  const cls = status === "valid" ? "ok" : status === "rejected" ? "bad" : "warn";
  return \`<span class="badge \${cls}">\${status}</span>\`;
}

function renderDashboard(me, connections) {
  appEl.innerHTML = \`
    <h2>Your IBKR connections</h2>
    <div id="conns"></div>

    <h2>Add a connection</h2>
    <div class="card">
      <label>Mode</label>
      <div class="row" id="add-mode-row" style="gap:16px;align-items:center;">
        <label style="display:flex;align-items:center;gap:6px;font-weight:normal;color:var(--fg);margin:0;">
          <input type="radio" name="add-mode" value="paper" checked /> Paper
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-weight:normal;color:var(--fg);margin:0;">
          <input type="radio" name="add-mode" value="live" /> Live
        </label>
        <span class="muted" style="margin-left:auto;font-size:12px;">
          <a href="/help/paper-account" target="_blank">paper?</a>
          &nbsp;·&nbsp;
          <a href="/help/authenticator-app" target="_blank">live?</a>
        </span>
      </div>

      <label>Label (your reference)</label>
      <input id="add-label" placeholder="paper account" />
      <label>IBKR username</label>
      <input id="add-username" autocomplete="off" />
      <label>IBKR password</label>
      <input id="add-password" type="password" autocomplete="new-password" />

      <div id="add-totp-wrap" style="display:none;">
        <label>Authenticator App activation code</label>
        <input id="add-totp" type="password" autocomplete="off"
               placeholder="base32 secret IBKR showed at enrollment" />
        <p class="muted" style="margin:4px 0 0;font-size:12px;">
          The activation code (the base32 secret, not a 6-digit code)
          IBKR showed you when you enrolled
          <a href="/help/authenticator-app" target="_blank">Authenticator App</a>.
          Required for unattended live re-auth. Stored in GCP Secret Manager.
        </p>
      </div>

      <div style="margin-top:12px"><button id="add-btn">Create connection</button></div>
      <div id="add-err" class="err"></div>
    </div>
  \`;

  const list = document.getElementById("conns");
  if (!connections.length) {
    list.innerHTML = '<div class="empty">No connections yet.</div>';
  } else {
    list.innerHTML = "";
    for (const c of connections) {
      const div = document.createElement("div");
      div.className = "card conn";
      div.innerHTML = renderConnection(c);
      list.appendChild(div);
      wireConnection(div, c);
    }
  }

  // Show/hide the activation-code field as the mode toggles.
  const totpWrap = document.getElementById("add-totp-wrap");
  const totpInput = document.getElementById("add-totp");
  const syncTotpVisibility = () => {
    const mode = document.querySelector('input[name="add-mode"]:checked').value;
    totpWrap.style.display = mode === "live" ? "" : "none";
    if (mode !== "live") totpInput.value = "";
  };
  for (const r of document.querySelectorAll('input[name="add-mode"]')) {
    r.addEventListener("change", syncTotpVisibility);
  }
  syncTotpVisibility();

  document.getElementById("add-btn").addEventListener("click", async () => {
    const errEl = document.getElementById("add-err");
    errEl.textContent = "";
    const mode = document.querySelector('input[name="add-mode"]:checked').value;
    const body = {
      label: document.getElementById("add-label").value || null,
      mode,
      ibkr_username: document.getElementById("add-username").value,
      ibkr_password: document.getElementById("add-password").value,
    };
    if (!body.ibkr_username || !body.ibkr_password) {
      errEl.textContent = "username and password are required";
      return;
    }
    if (mode === "live") {
      const totp = totpInput.value.trim();
      if (!totp) {
        errEl.textContent =
          "live mode requires the Authenticator App activation code (see /help/authenticator-app)";
        return;
      }
      body.ibkr_totp_secret = totp;
    }
    try {
      await api("POST", "/connections", body);
      await renderApp();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
}

function renderConnection(c) {
  const modeBadge = c.mode === "live"
    ? '<span class="badge bad">live</span>'
    : '<span class="badge">paper</span>';
  return \`
    <div class="conn-head">
      <div>
        <span class="conn-title">\${escapeHtml(c.label || "(no label)")}</span>
        \${modeBadge}
        \${badge(c.credential_status)}
      </div>
      <div class="row" style="gap:8px">
        <button data-act="test">Test</button>
        <button class="ghost" data-act="rotate">rotate creds</button>
        <button class="danger" data-act="delete">delete</button>
      </div>
    </div>
    <div class="conn-body">
      <div class="muted" style="margin-top:8px">
        id: <code>\${c.id}</code>
        \${c.ibkr_account_id ? "· account: <code>" + escapeHtml(c.ibkr_account_id) + "</code>" : ""}
      </div>
      <h2 style="margin-top:16px">API keys</h2>
      <div data-keys></div>
      <button data-act="new-key" style="margin-top:8px">+ New API key</button>
    </div>
  \`;
}

function wireConnection(div, c) {
  loadKeys(div, c.id);

  div.querySelector('[data-act="test"]').addEventListener("click", async () => {
    const btn = div.querySelector('[data-act="test"]');
    const prevHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Testing…';
    // Clear any prior result panel.
    div.querySelectorAll(".test-result").forEach((n) => n.remove());
    try {
      const resp = await fetch("/console/api/connections/" + c.id + "/test", {
        method: "POST",
        headers: { "Authorization": "Bearer " + currentToken },
      });
      const data = await resp.json();
      renderTestResult(div, data, resp.ok);
      // Refresh the badge in place (without wiping the result panel).
      updateConnectionBadge(div, resp.ok ? "valid" : "rejected");
    } catch (err) {
      renderTestResult(div, { error: err.message }, false);
    } finally {
      btn.disabled = false;
      btn.innerHTML = prevHtml;
    }
  });

  div.querySelector('[data-act="delete"]').addEventListener("click", async () => {
    if (!confirm("Delete this connection? This destroys the stored credentials and revokes all API keys.")) return;
    await api("DELETE", "/connections/" + c.id);
    await renderApp();
  });

  div.querySelector('[data-act="rotate"]').addEventListener("click", async () => {
    const username = prompt("IBKR username:");
    if (!username) return;
    const password = prompt("IBKR password:");
    if (!password) return;
    const body = { ibkr_username: username, ibkr_password: password };
    if (c.mode === "live") {
      const totp = prompt(
        "Authenticator App activation code (the base32 secret, not a 6-digit code):"
      );
      if (!totp) return;
      body.ibkr_totp_secret = totp;
    }
    try {
      await api("PUT", "/connections/" + c.id + "/credentials", body);
      alert("Credentials rotated.");
      await renderApp();
    } catch (err) {
      alert("Rotation failed: " + err.message);
    }
  });

  div.querySelector('[data-act="new-key"]').addEventListener("click", async () => {
    const label = prompt("Label for this key (optional):") || null;
    try {
      const k = await api("POST", "/connections/" + c.id + "/api-keys", { label });
      const note = document.createElement("div");
      note.className = "raw-key";
      note.innerHTML = '<strong>Copy this key now — it will not be shown again:</strong><br>' +
        '<code>' + escapeHtml(k.raw_key) + '</code>';
      div.querySelector(".conn-body").prepend(note);
      await loadKeys(div, c.id);
    } catch (err) {
      alert("Could not create key: " + err.message);
    }
  });
}

async function loadKeys(div, connId) {
  const container = div.querySelector("[data-keys]");
  container.innerHTML = '<div class="muted">Loading…</div>';
  const { api_keys } = await api("GET", "/connections/" + connId + "/api-keys");
  if (!api_keys.length) {
    container.innerHTML = '<div class="muted">No keys yet.</div>';
    return;
  }
  container.innerHTML = \`
    <table>
      <thead><tr><th>Label</th><th>Prefix</th><th>Created</th><th>Last used</th><th></th></tr></thead>
      <tbody>
        \${api_keys.map((k) => \`
          <tr>
            <td>\${escapeHtml(k.label || "")}</td>
            <td><code>ibkr_\${escapeHtml(k.key_prefix)}…</code></td>
            <td class="muted">\${k.created_at ? new Date(k.created_at).toLocaleString() : ""}</td>
            <td class="muted">\${k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}</td>
            <td>\${k.revoked_at
              ? '<span class="badge bad">revoked</span>'
              : '<button class="ghost" data-revoke="' + k.id + '">revoke</button>'}</td>
          </tr>
        \`).join("")}
      </tbody>
    </table>
  \`;
  container.querySelectorAll("[data-revoke]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Revoke this API key? This is immediate and irreversible.")) return;
      await api("DELETE", "/api-keys/" + btn.dataset.revoke);
      await loadKeys(div, connId);
    });
  });
}

function updateConnectionBadge(div, status) {
  const head = div.querySelector(".conn-head > div:first-child");
  if (!head) return;
  const old = head.querySelector(".badge");
  if (old) old.remove();
  const span = document.createElement("span");
  const cls = status === "valid" ? "ok" : status === "rejected" ? "bad" : "warn";
  span.className = "badge " + cls;
  span.textContent = status;
  head.appendChild(span);
}

function renderTestResult(div, data, ok) {
  const panel = document.createElement("div");
  panel.className = "test-result";
  if (ok) {
    const accounts = (data.ibkr_accounts || []).map(escapeHtml).join(", ") || "(none returned)";
    panel.innerHTML =
      '<div class="card" style="background:rgba(79,184,122,0.08); border-color: var(--ok); margin-top: 12px">' +
      '<strong style="color:var(--ok)">✓ Authenticated.</strong><br>' +
      '<span class="muted">IBKR account(s): ' + accounts + '</span>' +
      '</div>';
  } else {
    const remediation = data.remediation ? '<pre style="white-space:pre-wrap; margin:8px 0 0; font-family: -apple-system, sans-serif; font-size: 13px;">' + escapeHtml(data.remediation) + '</pre>' : '';
    const logs = data.logs
      ? '<details style="margin-top: 8px"><summary class="muted" style="cursor:pointer">Container logs (last 120 lines)</summary>' +
        '<pre style="white-space:pre-wrap; font-size: 11px; max-height: 320px; overflow:auto; margin: 8px 0 0; background: var(--bg); padding: 8px; border-radius: 4px;">' +
        escapeHtml(data.logs) + '</pre></details>'
      : '';
    panel.innerHTML =
      '<div class="card" style="background:rgba(211,84,84,0.08); border-color: var(--danger); margin-top: 12px">' +
      '<strong style="color:var(--danger)">✗ ' + escapeHtml(data.code || "ERROR") + '</strong><br>' +
      '<span>' + escapeHtml(data.error || "Test failed.") + '</span>' +
      remediation +
      logs +
      '</div>';
  }
  // Insert the panel just below the connection head.
  const body = div.querySelector(".conn-body");
  body.prepend(panel);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
</script>
</body>
</html>`;
}
