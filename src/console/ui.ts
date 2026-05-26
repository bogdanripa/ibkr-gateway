// Console SPA — single HTML page, Firebase JS SDK from CDN, vanilla JS.
// Served from /console by src/index.ts.
//
// UX principles:
//   · Every action has a loading state — buttons disable and show a
//     spinner with present-continuous label ("Creating…", "Deleting…").
//   · No native prompt() / confirm() / alert() — they break flow and
//     can't be styled. We use our own modal primitive.
//   · Toasts confirm successful actions; errors are surfaced inline on
//     the form that caused them (closer to context).
//   · Every status badge has a tooltip explaining what the state means.
//   · Button labels are Title Case for consistency.

import { firebaseConfig } from "./firebase-config.js";

export function consoleHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>IBKR Gateway — Console</title>
<style>
  :root {
    --bg: #0e0f12;
    --bg-elev: #14161b;
    --fg: #e6e7ea;
    --fg-soft: #b4b7be;
    --muted: #8a8e96;
    --card: #15171c;
    --card-hover: #181b21;
    --border: #2a2d35;
    --border-soft: #1f2229;
    --accent: #5a8df0;
    --accent-soft: rgba(90,141,240,0.12);
    --danger: #d35454;
    --danger-soft: rgba(211,84,84,0.10);
    --warn: #d39654;
    --warn-soft: rgba(211,150,84,0.10);
    --ok: #4fb87a;
    --ok-soft: rgba(79,184,122,0.10);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--fg);
    -webkit-font-smoothing: antialiased;
  }

  /* -------- Top bar -------- */
  header {
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: var(--bg-elev);
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
  header .who { color: var(--muted); font-size: 13px; display: flex; gap: 12px; align-items: center; }

  /* -------- Layout -------- */
  main { max-width: 880px; margin: 32px auto; padding: 0 24px 80px; }
  section { margin-bottom: 32px; }
  section > h2 {
    font-size: 11px; font-weight: 600; color: var(--muted);
    margin: 0 0 12px; text-transform: uppercase; letter-spacing: 0.08em;
  }

  /* -------- Cards -------- */
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px 20px;
    margin-bottom: 12px;
  }
  .card.conn { padding: 0; transition: border-color 0.15s; }
  .card.conn:hover { border-color: #3a3e48; }
  .conn-head {
    padding: 16px 20px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .conn-title { font-weight: 600; font-size: 15px; }
  .conn-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .conn-body {
    padding: 16px 20px 18px;
    border-top: 1px solid var(--border-soft);
    background: rgba(0,0,0,0.12);
    border-radius: 0 0 10px 10px;
  }
  .conn-meta-line {
    color: var(--muted); font-size: 13px;
    display: flex; gap: 16px; flex-wrap: wrap; align-items: center;
  }
  .conn-meta-line code { background: var(--bg); padding: 1px 6px; border-radius: 4px; font-size: 12px; color: var(--fg-soft); }
  .conn-sub-h {
    font-size: 11px; font-weight: 600; color: var(--muted);
    margin: 20px 0 8px; text-transform: uppercase; letter-spacing: 0.08em;
    display: flex; justify-content: space-between; align-items: center;
  }

  /* -------- Badges + tooltips -------- */
  .badge {
    display: inline-flex; align-items: center;
    padding: 2px 8px; font-size: 11px; font-weight: 600;
    border-radius: 4px; background: #2a2d35; color: var(--muted);
    text-transform: lowercase; letter-spacing: 0.02em;
    cursor: help;
  }
  .badge.ok    { background: var(--ok-soft);     color: var(--ok); }
  .badge.warn  { background: var(--warn-soft);   color: var(--warn); }
  .badge.bad   { background: var(--danger-soft); color: var(--danger); }
  .badge.live  { background: var(--danger-soft); color: var(--danger); }
  .badge.paper { background: var(--accent-soft); color: var(--accent); }

  /* -------- Buttons -------- */
  button, .btn {
    background: var(--accent);
    color: white;
    border: 1px solid transparent;
    padding: 7px 14px;
    border-radius: 6px;
    font: inherit;
    font-weight: 500;
    line-height: 1.2;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.12s, border-color 0.12s, opacity 0.12s;
  }
  button:hover:not(:disabled), .btn:hover:not(:disabled) { filter: brightness(1.08); }
  button.ghost { background: transparent; color: var(--fg); border-color: var(--border); }
  button.ghost:hover:not(:disabled) { background: var(--bg-elev); border-color: #3a3e48; filter: none; }
  button.danger { background: var(--danger); }
  button.subtle { background: transparent; color: var(--muted); border-color: transparent; padding: 6px 10px; }
  button.subtle:hover:not(:disabled) { color: var(--fg); background: var(--bg-elev); filter: none; }
  button:disabled { opacity: 0.6; cursor: default; }
  .row { display: flex; gap: 8px; align-items: center; }
  .row.actions { gap: 8px; }

  /* -------- Spinner -------- */
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

  /* -------- Forms -------- */
  input, textarea, select {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 9px 11px;
    font: inherit;
    width: 100%;
    transition: border-color 0.12s, background 0.12s;
  }
  input:focus, textarea:focus, select:focus {
    outline: none;
    border-color: var(--accent);
    background: var(--bg-elev);
  }
  label.field-label {
    display: block; margin: 14px 0 4px;
    color: var(--muted); font-size: 12px;
    text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;
  }
  .field-help { font-size: 12px; color: var(--muted); margin: 6px 0 0; }
  .field-help a { color: var(--accent); }

  /* -------- Segmented mode toggle -------- */
  .seg {
    display: inline-flex; padding: 3px;
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 8px; gap: 0;
  }
  .seg label {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 14px;
    border-radius: 6px;
    color: var(--fg-soft);
    cursor: pointer;
    font-weight: 500;
    transition: background 0.12s, color 0.12s;
    user-select: none;
  }
  .seg input[type="radio"] { position: absolute; opacity: 0; pointer-events: none; }
  .seg label:has(input:checked) { background: var(--accent); color: white; }
  .seg label.live:has(input:checked) { background: var(--danger); }
  .seg label:hover:not(:has(input:checked)) { color: var(--fg); }

  /* -------- Empty state -------- */
  .empty-card {
    background: var(--card);
    border: 1px dashed var(--border);
    border-radius: 10px;
    padding: 32px 24px;
    text-align: center;
    color: var(--muted);
    margin-bottom: 16px;
  }
  .empty-card .big { font-size: 16px; color: var(--fg); margin-bottom: 4px; font-weight: 500; }

  /* -------- Collapsible <details> -------- */
  details.add-conn > summary {
    list-style: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 2px;
    border-radius: 6px;
    user-select: none;
  }
  details.add-conn > summary::-webkit-details-marker { display: none; }
  details.add-conn > summary:hover { background: var(--bg-elev); }
  details.add-conn > summary h2 { margin: 0 !important; }
  details.add-conn > summary .caret {
    color: var(--muted); font-size: 12px;
    transition: transform 0.12s ease-out;
    display: inline-block;
  }
  details.add-conn[open] > summary .caret { transform: rotate(90deg); }
  details.add-conn > .card { margin-top: 10px; }

  /* -------- Tables -------- */
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border-soft); font-size: 13px; }
  th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom-color: var(--border); }
  td.muted { color: var(--muted); }
  tr:last-child td { border-bottom: none; }
  code { background: var(--bg); padding: 1px 6px; border-radius: 4px; font-size: 12px; }

  /* -------- Inline notifications -------- */
  .err {
    color: var(--danger); margin-top: 10px; font-size: 13px; white-space: pre-wrap;
    background: var(--danger-soft); padding: 8px 12px; border-radius: 6px;
    border: 1px solid rgba(211,84,84,0.22);
  }
  .muted { color: var(--muted); }
  .signin {
    min-height: 60vh; display: flex; align-items: center; justify-content: center;
  }
  .signin .card { padding: 32px 28px; max-width: 380px; text-align: center; }
  .signin h2 { margin: 0 0 8px; color: var(--fg); text-transform: none; font-size: 18px; letter-spacing: -0.01em; }
  .signin p { color: var(--muted); margin: 0 0 18px; }

  /* -------- Toast -------- */
  #toasts {
    position: fixed; right: 24px; bottom: 24px; z-index: 1000;
    display: flex; flex-direction: column; gap: 8px; max-width: 360px;
  }
  .toast {
    background: var(--bg-elev); color: var(--fg);
    border: 1px solid var(--border);
    border-left-width: 3px;
    border-radius: 6px;
    padding: 10px 14px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.4);
    animation: toast-in 0.18s ease-out;
    font-size: 13px;
  }
  .toast.ok    { border-left-color: var(--ok); }
  .toast.bad   { border-left-color: var(--danger); }
  .toast.info  { border-left-color: var(--accent); }
  @keyframes toast-in { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }

  /* -------- Modal -------- */
  #modal-root {
    position: fixed; inset: 0; z-index: 900;
    background: rgba(0,0,0,0.55);
    display: none; align-items: center; justify-content: center;
    padding: 24px;
    animation: fade-in 0.12s ease-out;
  }
  #modal-root.open { display: flex; }
  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
  .modal {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 10px;
    width: 100%; max-width: 480px;
    box-shadow: 0 16px 64px rgba(0,0,0,0.6);
    overflow: hidden;
    animation: pop-in 0.18s ease-out;
  }
  @keyframes pop-in { from { transform: scale(0.96); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  .modal-head { padding: 16px 20px; border-bottom: 1px solid var(--border); }
  .modal-head h3 { margin: 0; font-size: 15px; font-weight: 600; }
  .modal-body { padding: 18px 20px; }
  .modal-body p { margin: 0 0 12px; color: var(--fg-soft); }
  .modal-foot {
    padding: 12px 20px;
    border-top: 1px solid var(--border);
    display: flex; gap: 8px; justify-content: flex-end;
    background: rgba(0,0,0,0.18);
  }

  /* -------- Raw-key reveal -------- */
  .raw-key {
    background: rgba(211,150,84,0.06);
    border: 1px solid var(--warn);
    padding: 14px;
    border-radius: 8px;
    margin: 12px 0;
  }
  .raw-key .label {
    color: var(--warn); font-size: 12px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px;
  }
  .raw-key .key-row { display: flex; gap: 8px; align-items: center; }
  .raw-key code {
    flex: 1; padding: 8px 12px; font-size: 13px;
    background: var(--bg); border-radius: 6px;
    word-break: break-all; user-select: all;
  }
  .raw-key .copy-btn { flex-shrink: 0; }

  /* -------- Test result -------- */
  .test-result { margin-top: 14px; }
  .test-result.ok  { background: var(--ok-soft);     border: 1px solid rgba(79,184,122,0.3);   border-radius: 8px; padding: 12px 14px; color: var(--fg-soft); }
  .test-result.bad { background: var(--danger-soft); border: 1px solid rgba(211,84,84,0.3);   border-radius: 8px; padding: 12px 14px; color: var(--fg-soft); }
  .test-result strong.ok  { color: var(--ok); }
  .test-result strong.bad { color: var(--danger); }
</style>
</head>
<body>

<header>
  <h1>IBKR Gateway</h1>
  <div class="who" id="who"></div>
</header>

<main id="app">
  <div class="signin">
    <div class="card">
      <h2>Welcome</h2>
      <p>Sign in with your Google account to manage your IBKR connections.</p>
      <button id="signin-btn">Sign in with Google</button>
      <p style="margin-top:18px; font-size:12px;">
        First time?
        <a href="/help/paper-account" style="color:var(--accent);">How paper accounts work</a>
        ·
        <a href="/help/authenticator-app" style="color:var(--accent);">Live setup (Authenticator App)</a>
      </p>
    </div>
  </div>
</main>

<div id="modal-root"></div>
<div id="toasts"></div>

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
  whoEl.innerHTML = \`<span>\${escapeHtml(user.email)}</span> <button class="subtle" id="signout">Sign out</button>\`;
  document.getElementById("signout").addEventListener("click", () => signOut(auth));
  renderApp();
});

// ----------------------- HTTP helper -----------------------

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
    let detail = "";
    try { const j = await resp.json(); detail = j.error || j.detail || JSON.stringify(j); }
    catch { detail = await resp.text(); }
    throw new Error(detail || ("HTTP " + resp.status));
  }
  return resp.json();
}

// ----------------------- Loading helper -----------------------
//
// withLoading(btn, "Doing thing…", fn) — disables the button, swaps
// its HTML for a spinner + the given present-continuous label, runs
// fn, then restores. Returns whatever fn returned (or rethrows).
async function withLoading(btn, label, fn) {
  const prevHtml = btn.innerHTML;
  const prevDisabled = btn.disabled;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>' + label;
  try {
    return await fn();
  } finally {
    btn.innerHTML = prevHtml;
    btn.disabled = prevDisabled;
  }
}

// ----------------------- Toast -----------------------

function toast(message, kind = "info", timeoutMs = 4500) {
  const root = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 0.18s, transform 0.18s";
    el.style.opacity = "0";
    el.style.transform = "translateY(4px)";
    setTimeout(() => el.remove(), 180);
  }, timeoutMs);
}

// ----------------------- Modal -----------------------
//
// openModal({title, body, primary:{label, kind?, onClick}, secondary?, dismissOnBackdrop?})
//   · body is either a string of HTML or a function returning {html, mount(el)}.
//   · primary.onClick receives the modal element so it can read inputs.
//     If onClick returns a Promise the primary button shows a loading
//     state with the same label rendered as present continuous (caller
//     supplies a label like "Delete" — we render "Deleting…"; if the
//     label already ends in "…", we use it as-is).
//   · onClick may return a string error to keep the modal open and show
//     the error inline; any other (resolved) value closes the modal.
//
function openModal({ title, body, primary, secondary, dismissOnBackdrop = true }) {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root");
    root.innerHTML = '';
    const m = document.createElement("div");
    m.className = "modal";

    const head = document.createElement("div");
    head.className = "modal-head";
    head.innerHTML = '<h3>' + escapeHtml(title) + '</h3>';
    m.appendChild(head);

    const bodyEl = document.createElement("div");
    bodyEl.className = "modal-body";
    if (typeof body === "string") bodyEl.innerHTML = body;
    else if (typeof body === "function") {
      const r = body();
      if (typeof r === "string") bodyEl.innerHTML = r;
      else if (r?.html) {
        bodyEl.innerHTML = r.html;
        if (r.mount) r.mount(bodyEl);
      }
    }
    const errEl = document.createElement("div");
    errEl.className = "err";
    errEl.style.display = "none";
    bodyEl.appendChild(errEl);
    m.appendChild(bodyEl);

    const foot = document.createElement("div");
    foot.className = "modal-foot";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "ghost";
    cancelBtn.textContent = secondary?.label || "Cancel";
    cancelBtn.addEventListener("click", () => close(secondary?.value ?? null));
    foot.appendChild(cancelBtn);

    if (primary) {
      const primaryBtn = document.createElement("button");
      if (primary.kind === "danger") primaryBtn.className = "danger";
      primaryBtn.textContent = primary.label;
      primaryBtn.addEventListener("click", async () => {
        errEl.style.display = "none";
        errEl.textContent = "";
        const loadingLabel = primary.loadingLabel || (
          primary.label.endsWith("…") ? primary.label : presentContinuous(primary.label)
        );
        try {
          const out = await withLoading(primaryBtn, loadingLabel, async () => primary.onClick(m));
          if (typeof out === "string" && out.length) {
            errEl.textContent = out;
            errEl.style.display = "";
            return;
          }
          close(out ?? true);
        } catch (e) {
          errEl.textContent = e.message || String(e);
          errEl.style.display = "";
        }
      });
      foot.appendChild(primaryBtn);
    }

    m.appendChild(foot);
    root.appendChild(m);
    root.classList.add("open");

    function close(value) {
      root.classList.remove("open");
      root.innerHTML = '';
      document.removeEventListener("keydown", onKey);
      resolve(value);
    }
    function onKey(e) {
      if (e.key === "Escape") close(null);
    }
    document.addEventListener("keydown", onKey);
    if (dismissOnBackdrop) {
      root.addEventListener("click", (e) => { if (e.target === root) close(null); }, { once: true });
    }

    // Focus the first input/button.
    setTimeout(() => {
      const target = m.querySelector("input,textarea,select") || cancelBtn;
      target.focus();
    }, 0);
  });
}

function presentContinuous(verb) {
  // "Delete" → "Deleting…", "Rotate credentials" → "Rotating credentials…",
  // "Generate key" → "Generating key…", "Create connection" → "Creating connection…".
  const parts = verb.trim().split(/\\s+/);
  const head = parts[0];
  const ing = head.match(/[eE]$/) ? head.slice(0, -1) + "ing"
            : /[bdghlmnprt]$/.test(head) && head.length <= 6 ? head + head.slice(-1) + "ing"
            : head + "ing";
  return [ing, ...parts.slice(1)].join(" ") + "…";
}

async function confirmDanger({ title, body, primary }) {
  return openModal({
    title,
    body: '<p>' + body + '</p>',
    primary: { ...primary, kind: "danger" },
  });
}

// ----------------------- Tooltips -----------------------

function tooltipFor(kind, value, c) {
  switch (kind) {
    case "mode":
      return value === "live"
        ? "Live — real money. Orders move actual funds."
        : "Paper — simulated trading. No real money at risk.";
    case "status": {
      switch (value) {
        case "unknown":  return "Not yet verified. Click Test to confirm the stored credentials work.";
        case "valid":    return "Last sign-in succeeded" + (c?.credential_checked_at ? " at " + formatTime(c.credential_checked_at) : ".");
        case "rejected": return "IBKR rejected the stored credentials. Rotate them and try again.";
        default:         return value;
      }
    }
  }
  return "";
}

// ----------------------- Time formatting -----------------------

function formatTime(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
function formatRel(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms)) return iso;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + " min ago";
  if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + " h ago";
  if (ms < 7 * 86_400_000) return Math.floor(ms / 86_400_000) + " d ago";
  return new Date(iso).toLocaleDateString();
}

// ----------------------- Render: signin -----------------------

function renderSignin() {
  appEl.innerHTML = \`
    <div class="signin">
      <div class="card">
        <h2>Welcome</h2>
        <p>Sign in with your Google account to manage your IBKR connections.</p>
        <button id="signin-btn">Sign in with Google</button>
        <p style="margin-top:18px; font-size:12px;">
          First time?
          <a href="/help/paper-account" style="color:var(--accent);">How paper accounts work</a>
          ·
          <a href="/help/authenticator-app" style="color:var(--accent);">Live setup (Authenticator App)</a>
        </p>
      </div>
    </div>\`;
  document.getElementById("signin-btn").addEventListener("click", () => signInWithPopup(auth, provider));
}

// ----------------------- Render: dashboard -----------------------

async function renderApp() {
  appEl.innerHTML = '<div class="muted" style="padding: 40px 0; text-align:center;"><span class="spinner"></span>Loading…</div>';
  try {
    const me = await api("GET", "/me");
    const { connections } = await api("GET", "/connections");
    renderDashboard(me, connections);
  } catch (err) {
    appEl.innerHTML = '<div class="err">' + escapeHtml(err.message) + '</div>';
  }
}

function badge(kind, value, c) {
  let cls = "warn";
  if (kind === "status") cls = value === "valid" ? "ok" : value === "rejected" ? "bad" : "warn";
  if (kind === "mode")   cls = value === "live" ? "live" : "paper";
  return '<span class="badge ' + cls + '" title="' + escapeHtml(tooltipFor(kind, value, c)) + '">' + escapeHtml(value) + '</span>';
}

function renderDashboard(me, connections) {
  appEl.innerHTML = \`
    <section>
      <h2>Your IBKR connections</h2>
      <div id="conns"></div>
    </section>

    <section>
      <details class="add-conn" \${connections.length === 0 ? "open" : ""}>
        <summary><h2 style="display:inline;">Add a connection</h2><span class="caret">▸</span></summary>
      <div class="card">
        <label class="field-label">Mode</label>
        <div class="row" style="justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
          <div class="seg" id="add-mode">
            <label class="paper"><input type="radio" name="add-mode" value="paper" checked /> Paper</label>
            <label class="live"><input type="radio" name="add-mode" value="live" /> Live</label>
          </div>
          <span class="muted" style="font-size:12px;">
            <a href="/help/paper-account" target="_blank" style="color:var(--accent);">What's paper?</a>
            ·
            <a href="/help/authenticator-app" target="_blank" style="color:var(--accent);">Live setup</a>
          </span>
        </div>

        <label class="field-label">Label <span style="color:var(--muted);font-weight:400;text-transform:none;letter-spacing:0;">(optional, for your reference)</span></label>
        <input id="add-label" placeholder="e.g. Paper account · main live" />

        <label class="field-label">IBKR username</label>
        <input id="add-username" autocomplete="off" />

        <label class="field-label">IBKR password</label>
        <input id="add-password" type="password" autocomplete="new-password" />

        <div id="add-totp-wrap" style="display:none;">
          <label class="field-label">Authenticator App activation code</label>
          <input id="add-totp" type="password" autocomplete="off"
                 placeholder="base32 secret from IBKR enrollment" />
          <p class="field-help">
            The base32 secret IBKR showed you when you enrolled
            <a href="/help/authenticator-app" target="_blank">Authenticator App</a> —
            not the rotating 6-digit code. Stored encrypted in GCP Secret Manager.
          </p>
        </div>

        <div style="margin-top:18px;"><button id="add-btn">Create connection</button></div>
        <div id="add-err" class="err" style="display:none;"></div>
      </div>
      </details>
    </section>
  \`;

  renderConnList(connections);

  // Mode toggle — show/hide activation code field.
  const totpWrap = document.getElementById("add-totp-wrap");
  const totpInput = document.getElementById("add-totp");
  const syncTotpVisibility = () => {
    const mode = document.querySelector('input[name="add-mode"]:checked').value;
    totpWrap.style.display = mode === "live" ? "" : "none";
    if (mode !== "live") totpInput.value = "";
  };
  for (const r of document.querySelectorAll('input[name="add-mode"]')) r.addEventListener("change", syncTotpVisibility);
  syncTotpVisibility();

  // Submit.
  const addBtn = document.getElementById("add-btn");
  addBtn.addEventListener("click", async () => {
    const errEl = document.getElementById("add-err");
    errEl.style.display = "none"; errEl.textContent = "";
    const mode = document.querySelector('input[name="add-mode"]:checked').value;
    const body = {
      label: document.getElementById("add-label").value || null,
      mode,
      ibkr_username: document.getElementById("add-username").value.trim(),
      ibkr_password: document.getElementById("add-password").value,
    };
    if (!body.ibkr_username || !body.ibkr_password) {
      errEl.textContent = "Username and password are required.";
      errEl.style.display = "";
      return;
    }
    if (mode === "live") {
      const t = totpInput.value.trim();
      if (!t) {
        errEl.textContent = "Live mode requires the Authenticator App activation code. See the help link above.";
        errEl.style.display = "";
        return;
      }
      body.ibkr_totp_secret = t;
    }
    try {
      await withLoading(addBtn, "Creating connection…", () => api("POST", "/connections", body));
      toast("Connection created", "ok");
      await renderApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = "";
    }
  });
}

function renderConnList(connections) {
  const list = document.getElementById("conns");
  if (!connections.length) {
    list.innerHTML = \`
      <div class="empty-card">
        <div class="big">No connections yet</div>
        <div>Add your first IBKR connection below. Start with a paper account.</div>
      </div>\`;
    return;
  }
  list.innerHTML = "";
  for (const c of connections) {
    const div = document.createElement("div");
    div.className = "card conn";
    div.innerHTML = renderConnection(c);
    list.appendChild(div);
    wireConnection(div, c);
  }
}

function renderConnection(c) {
  return \`
    <div class="conn-head">
      <div class="conn-meta">
        <span class="conn-title">\${escapeHtml(c.label || "(no label)")}</span>
        \${badge("mode", c.mode || "paper")}
        \${badge("status", c.credential_status, c)}
      </div>
      <div class="row actions">
        <button data-act="test">Test</button>
        <button class="ghost" data-act="positions"
          \${c.credential_status === "valid" ? "" : "disabled"}
          title="\${c.credential_status === "valid"
            ? "Fetch portfolio snapshot — proves the runtime path end-to-end"
            : "Test the connection first to enable"}"
        >Positions</button>
        <button class="ghost" data-act="rotate">Update credentials</button>
        <button class="danger" data-act="delete">Delete</button>
      </div>
    </div>
    <div class="conn-body">
      <div class="conn-meta-line">
        <span>ID: <code>\${escapeHtml(c.id)}</code></span>
        \${c.ibkr_account_id ? '<span>Account: <code>' + escapeHtml(c.ibkr_account_id) + '</code></span>' : ''}
        \${c.credential_checked_at ? '<span>Last verified ' + escapeHtml(formatRel(c.credential_checked_at)) + '</span>' : ''}
      </div>
      <div class="conn-sub-h">
        <span>API keys</span>
        <button class="ghost" data-act="new-key">+ New API key</button>
      </div>
      <div data-keys></div>
    </div>
  \`;
}

function wireConnection(div, c) {
  loadKeys(div, c.id);

  div.querySelector('[data-act="test"]').addEventListener("click", async () => {
    const btn = div.querySelector('[data-act="test"]');
    div.querySelectorAll(".test-result, .positions-panel").forEach((n) => n.remove());
    try {
      const resp = await withLoading(btn, "Testing…", async () => {
        const r = await fetch("/console/api/connections/" + c.id + "/test", {
          method: "POST",
          headers: { "Authorization": "Bearer " + currentToken },
        });
        return { ok: r.ok, data: await r.json() };
      });
      renderTestResult(div, resp.data, resp.ok);
      updateConnectionBadge(div, resp.ok ? "valid" : "rejected", c);
      // Enable / disable the Positions button to reflect the new state.
      const posBtn = div.querySelector('[data-act="positions"]');
      if (posBtn) {
        if (resp.ok) {
          posBtn.removeAttribute("disabled");
          posBtn.title = "Fetch portfolio snapshot — proves the runtime path end-to-end";
          c.credential_status = "valid";
        } else {
          posBtn.setAttribute("disabled", "");
          posBtn.title = "Test the connection first to enable";
          c.credential_status = "rejected";
        }
      }
      if (resp.ok) toast("Authenticated", "ok");
    } catch (err) {
      renderTestResult(div, { error: err.message }, false);
      toast("Test failed", "bad");
    }
  });

  div.querySelector('[data-act="positions"]').addEventListener("click", async () => {
    const btn = div.querySelector('[data-act="positions"]');
    if (btn.hasAttribute("disabled")) return;
    div.querySelectorAll(".positions-panel, .test-result").forEach((n) => n.remove());
    try {
      const resp = await withLoading(btn, "Loading…", async () => {
        const r = await fetch("/console/api/connections/" + c.id + "/positions", {
          headers: { "Authorization": "Bearer " + currentToken },
        });
        return { ok: r.ok, data: await r.json() };
      });
      renderPositionsPanel(div, resp.data, resp.ok);
      if (resp.ok) toast("Positions loaded", "ok");
    } catch (err) {
      renderPositionsPanel(div, { error: err.message }, false);
      toast("Couldn't load positions", "bad");
    }
  });

  div.querySelector('[data-act="delete"]').addEventListener("click", async () => {
    const ok = await confirmDanger({
      title: "Delete this connection?",
      body: "This destroys the stored credentials in Secret Manager and revokes every API key for this connection. <strong>Cannot be undone.</strong>",
      primary: { label: "Delete", onClick: async () => api("DELETE", "/connections/" + c.id) },
    });
    if (ok) {
      toast("Connection deleted", "ok");
      await renderApp();
    }
  });

  div.querySelector('[data-act="rotate"]').addEventListener("click", async () => {
    const ok = await openModal({
      title: "Update credentials — " + (c.label || c.id),
      body: () => ({
        html: \`
          <p class="muted" style="margin-top:0">
            Update the stored \${c.mode === "live" ? "live" : "paper"} credentials.
            \${c.mode === "live" ? "You'll need to re-supply the activation code too — it's the master key for the unattended re-auth path." : ""}
          </p>
          <label class="field-label">IBKR username</label>
          <input id="rot-u" autocomplete="off" />
          <label class="field-label">IBKR password</label>
          <input id="rot-p" type="password" autocomplete="new-password" />
          \${c.mode === "live" ? \`
            <label class="field-label">Activation code (base32 secret)</label>
            <input id="rot-t" type="password" autocomplete="off" placeholder="from IBKR Authenticator App enrollment" />
            <p class="field-help">Required when rotating live credentials. <a href="/help/authenticator-app" target="_blank">What's this?</a></p>
          \` : ''}
        \`,
      }),
      primary: {
        label: "Save",
        loadingLabel: "Saving…",
        onClick: async (m) => {
          const body = {
            ibkr_username: m.querySelector("#rot-u").value.trim(),
            ibkr_password: m.querySelector("#rot-p").value,
          };
          if (!body.ibkr_username || !body.ibkr_password) return "Username and password are required.";
          if (c.mode === "live") {
            const t = m.querySelector("#rot-t").value.trim();
            if (!t) return "Activation code is required for live mode.";
            body.ibkr_totp_secret = t;
          }
          await api("PUT", "/connections/" + c.id + "/credentials", body);
          return true;
        },
      },
    });
    if (ok) {
      toast("Credentials updated", "ok");
      await renderApp();
    }
  });

  div.querySelector('[data-act="new-key"]').addEventListener("click", async () => {
    const result = await openModal({
      title: "New API key",
      body: () => ({
        html: \`
          <p class="muted" style="margin-top:0">
            Optional label so you can identify this key later (e.g. "Claude Desktop", "n8n workflow").
          </p>
          <label class="field-label">Label</label>
          <input id="nk-label" placeholder="Claude Desktop" />
        \`,
      }),
      primary: {
        label: "Generate key",
        loadingLabel: "Generating…",
        onClick: async (m) => {
          const label = m.querySelector("#nk-label").value.trim() || null;
          return api("POST", "/connections/" + c.id + "/api-keys", { label });
        },
      },
    });
    if (!result || !result.raw_key) return;
    showRawKey(div, result.raw_key);
    await loadKeys(div, c.id);
  });
}

function showRawKey(div, raw) {
  // Remove any previous raw-key panel.
  div.querySelectorAll(".raw-key").forEach((n) => n.remove());
  const note = document.createElement("div");
  note.className = "raw-key";
  note.innerHTML = \`
    <div class="label">⚠ Copy this key now — it won't be shown again</div>
    <div class="key-row">
      <code>\${escapeHtml(raw)}</code>
      <button class="copy-btn ghost">Copy</button>
    </div>
  \`;
  note.querySelector(".copy-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(raw);
      btn.textContent = "Copied ✓";
      setTimeout(() => { btn.textContent = "Copy"; }, 1500);
      toast("API key copied to clipboard", "ok");
    } catch {
      toast("Couldn't copy — select and copy manually", "bad");
    }
  });
  div.querySelector(".conn-body").prepend(note);
}

async function loadKeys(div, connId) {
  const container = div.querySelector("[data-keys]");
  container.innerHTML = '<div class="muted" style="padding:8px 0;"><span class="spinner"></span>Loading…</div>';
  try {
    const { api_keys } = await api("GET", "/connections/" + connId + "/api-keys");
    if (!api_keys.length) {
      container.innerHTML = '<div class="muted" style="padding:8px 0;">No keys yet. Generate one to talk to <code>/mcp</code> or future <code>/v1/api/*</code> endpoints.</div>';
      return;
    }
    container.innerHTML = \`
      <table>
        <thead><tr><th>Label</th><th>Prefix</th><th>Created</th><th>Last used</th><th></th></tr></thead>
        <tbody>
          \${api_keys.map((k) => \`
            <tr>
              <td>\${escapeHtml(k.label || "—")}</td>
              <td><code>ibkr_\${escapeHtml(k.key_prefix)}…</code></td>
              <td class="muted" title="\${escapeHtml(formatTime(k.created_at))}">\${escapeHtml(formatRel(k.created_at))}</td>
              <td class="muted" title="\${escapeHtml(formatTime(k.last_used_at))}">\${escapeHtml(formatRel(k.last_used_at))}</td>
              <td style="text-align:right;">
                \${k.revoked_at
                  ? '<span class="badge bad" title="Revoked ' + escapeHtml(formatRel(k.revoked_at)) + '">revoked</span>'
                  : '<button class="subtle" data-revoke="' + escapeHtml(k.id) + '" data-label="' + escapeHtml(k.label || k.key_prefix) + '">Revoke</button>'}
              </td>
            </tr>
          \`).join("")}
        </tbody>
      </table>
    \`;
    container.querySelectorAll("[data-revoke]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.revoke;
        const label = btn.dataset.label;
        const ok = await confirmDanger({
          title: "Revoke API key?",
          body: "Key <code>" + escapeHtml(label) + "</code> will stop working immediately. Existing API consumers using it will be denied. <strong>Cannot be undone.</strong>",
          primary: { label: "Revoke", onClick: async () => api("DELETE", "/api-keys/" + id) },
        });
        if (ok) {
          toast("API key revoked", "ok");
          await loadKeys(div, connId);
        }
      });
    });
  } catch (err) {
    container.innerHTML = '<div class="err">Could not load keys: ' + escapeHtml(err.message) + '</div>';
  }
}

function updateConnectionBadge(div, status, c) {
  const meta = div.querySelector(".conn-meta");
  if (!meta) return;
  // Find + replace the second badge (status). Mode badge stays.
  const badges = meta.querySelectorAll(".badge");
  if (badges.length >= 2) badges[1].outerHTML = badge("status", status, { ...c, credential_checked_at: new Date().toISOString() });
}

function renderTestResult(div, data, ok) {
  const panel = document.createElement("div");
  panel.className = "test-result " + (ok ? "ok" : "bad");
  if (ok) {
    const accounts = (data.ibkr_accounts || []).map(escapeHtml).join(", ") || "(none returned)";
    panel.innerHTML = '<strong class="ok">✓ Authenticated</strong> · IBKR account(s): ' + accounts;
  } else {
    panel.innerHTML = '<strong class="bad">✗ ' + escapeHtml(data.code || "Test failed") + '</strong><br>' +
      '<span class="muted">' + escapeHtml(data.error || "Unknown error.") + '</span>';
  }
  div.querySelector(".conn-body").prepend(panel);
}

function renderPositionsPanel(div, data, ok) {
  const panel = document.createElement("div");
  panel.className = "positions-panel";
  if (!ok) {
    panel.classList.add("test-result", "bad");
    panel.innerHTML = '<strong class="bad">✗ ' + escapeHtml(data.code || "Positions fetch failed") + '</strong><br>' +
      '<span class="muted">' + escapeHtml(data.error || "Unknown error.") + '</span>';
    div.querySelector(".conn-body").prepend(panel);
    return;
  }

  const s = data.snapshot || {};
  const stocks  = s.stocks  || [];
  const options = s.options || [];
  const other   = s.other   || {};
  const cash    = (s.cash || []).filter((r) => Number(r.cash) || Number(r.netLiq));

  // Surface partial errors (e.g. paper accounts return 500 on /positions
  // even when /ledger works), then render whatever did come back.
  const errs = s.errors || {};
  const errLines = Object.entries(errs)
    .map(([k, v]) => '<div class="muted" style="font-size:12px;">' + escapeHtml(k) + ': ' + escapeHtml(String(v)) + '</div>')
    .join("");

  const fmt = (n, frac = 2) => {
    if (n == null || isNaN(Number(n))) return "—";
    return Number(n).toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac });
  };
  const stockTable = (rows) => rows.length === 0 ? '<div class="muted" style="padding:6px 0;">(none)</div>' : \`
    <table>
      <thead><tr>
        <th>Symbol</th><th style="text-align:right">Qty</th>
        <th style="text-align:right">Avg cost</th><th style="text-align:right">Mkt px</th>
        <th style="text-align:right">Mkt value</th><th style="text-align:right">P&L</th><th>Ccy</th>
      </tr></thead>
      <tbody>
        \${rows.map((p) => \`
          <tr>
            <td>\${escapeHtml(p.contractDesc || p.ticker || "—")}</td>
            <td style="text-align:right">\${fmt(p.position, 0)}</td>
            <td style="text-align:right" class="muted">\${fmt(p.avgCost)}</td>
            <td style="text-align:right" class="muted">\${fmt(p.mktPrice)}</td>
            <td style="text-align:right">\${fmt(p.mktValue)}</td>
            <td style="text-align:right">\${fmt(p.unrealizedPnl)}</td>
            <td class="muted">\${escapeHtml(p.currency || "")}</td>
          </tr>\`).join("")}
      </tbody>
    </table>\`;

  const cashTable = cash.length === 0 ? '<div class="muted" style="padding:6px 0;">(no cash positions)</div>' : \`
    <table>
      <thead><tr>
        <th>Ccy</th>
        <th style="text-align:right">Cash</th>
        <th style="text-align:right">Net liq</th>
        <th style="text-align:right">Unr. P&L</th>
        <th style="text-align:right">Excess liq</th>
      </tr></thead>
      <tbody>
        \${cash.map((r) => \`
          <tr>
            <td>\${escapeHtml(r.ccy === "BASE" ? "Total (base)" : (r.ccy || ""))}</td>
            <td style="text-align:right">\${fmt(r.cash)}</td>
            <td style="text-align:right">\${fmt(r.netLiq)}</td>
            <td style="text-align:right" class="muted">\${fmt(r.unrealizedPnl)}</td>
            <td style="text-align:right" class="muted">\${fmt(r.excessLiq)}</td>
          </tr>\`).join("")}
      </tbody>
    </table>\`;

  const otherSection = Object.keys(other).length === 0 ? "" :
    Object.entries(other).map(([k, rows]) => \`
      <div class="conn-sub-h" style="margin-top:18px;"><span>\${escapeHtml(k)}</span></div>
      \${stockTable(rows)}
    \`).join("");

  panel.innerHTML = \`
    <div class="card" style="margin-top:14px; margin-bottom:0;">
      <div class="conn-meta-line" style="margin-bottom:4px;">
        <strong style="color:var(--fg);">Portfolio</strong>
        \${s.accountId ? '<span>· account <code>' + escapeHtml(s.accountId) + '</code></span>' : ''}
      </div>
      \${errLines ? '<div style="margin:6px 0 4px;">' + errLines + '</div>' : ''}
      <div class="conn-sub-h" style="margin-top:14px;"><span>Stocks</span></div>
      \${stockTable(stocks)}
      <div class="conn-sub-h" style="margin-top:18px;"><span>Options</span></div>
      \${stockTable(options)}
      \${otherSection}
      <div class="conn-sub-h" style="margin-top:18px;"><span>Cash</span></div>
      \${cashTable}
    </div>
  \`;
  div.querySelector(".conn-body").prepend(panel);
}

// ----------------------- Utilities -----------------------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
</script>
</body>
</html>`;
}
