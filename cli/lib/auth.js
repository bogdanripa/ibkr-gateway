// Re-implements the post-login pipeline that GatewayHttpProxy /
// ClientPortalService / SsoService run inside the Java gateway. See
// docs/cpg-protocol.md §3 for the flow this mirrors.

import { api, persist, portalUrl, hostUrl } from './api.js';
import { computeSk, genDeviceRandom, generateTstToken } from './sso-math.js';

const SLEEP_MS = (ms) => new Promise((r) => setTimeout(r, ms));

class AuthError extends Error {
  constructor(stage, status, body) {
    super(`auth failed at ${stage}: HTTP ${status} ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.stage = stage; this.status = status; this.body = body;
  }
}

function expect200(stage, res) {
  if (res.status !== 200) throw new AuthError(stage, res.status, res.data);
  return res.data;
}

// Equivalent of ClientPortalService.authenticate (sso/validate?gw=1).
// Pulls USER_ID/USER_NAME into the session.
export async function validateSso(session) {
  const res = await api.get(session, portalUrl(session, 'sso/validate?gw=1'));
  const data = expect200('sso/validate', res);
  if (data && typeof data === 'object') {
    if (data.USER_ID) session.userId = data.USER_ID;
    if (data.USER_NAME) session.userName = data.USER_NAME;
    if (typeof data.IS_PENDING_APPLICANT === 'boolean') {
      session.isPendingApplicant = data.IS_PENDING_APPLICANT;
    }
    if (data.PAPER_USER_NAME) session.paperUserName = data.PAPER_USER_NAME;
  }
  return data;
}

// SsoService.ssoDHInit + setK — fetches the shared K from the server.
export async function fetchK(session) {
  expect200('ssodh/init', await api.get(session, portalUrl(session, 'ssodh/init')));
  const st = expect200('ssodh/st', await api.get(session, portalUrl(session, 'ssodh/st')));
  if (!st || !st.st) throw new AuthError('ssodh/st', 200, st);
  session.kHex = st.st;
  return st.st;
}

// SsoService.publishTstToken — best-effort, the position-reading path
// works without TST. We still try because it stabilises long sessions.
export async function publishTstToken(session) {
  if (!session.deviceId) session.deviceId = `${genDeviceRandom()}|00-00-00-00-00-00`;
  if (!session.kHex) throw new Error('publishTstToken called before fetchK');
  session.tstToken = generateTstToken(session.deviceId, session.kHex);
  const url = hostUrl(
    session,
    `/sso/Authenticator?ACTION=PUBLISH_TST&RESP_TYPE=JSON&DEVICE_ID=${encodeURIComponent(session.deviceId)}`,
  );
  try { await api.get(session, url); } catch (e) { /* non-fatal */ }
}

// ClientPortalService.getStatus / processAuthStatus / authenticateBrokerage
// / ssoDHResponse — the brokerage SSODH challenge/response dance.
export async function brokerageAuthenticate(session, { maxLoops = 8 } = {}) {
  for (let loop = 0; loop < maxLoops; loop++) {
    const status = expect200(
      'iserver/auth/status',
      await api.get(session, portalUrl(session, 'iserver/auth/status')),
    );
    if (status.authenticated && status.competing === false) return status;

    if (!session.userName) {
      throw new Error('brokerageAuthenticate: no userName in session — run validateSso first');
    }

    const post = {
      username: session.userName,
      machineId: genDeviceRandom(),
      compete: true,
    };
    const init = expect200(
      'iserver/auth/ssodh/init',
      await api.post(session, portalUrl(session, 'iserver/auth/ssodh/init'), post),
    );

    if (init.authenticated) continue;
    if (init.wait) { await SLEEP_MS(5000); continue; }
    if (init.error) throw new AuthError('iserver/auth/ssodh/init', 200, init);
    if (!init.challenge) throw new AuthError('iserver/auth/ssodh/init', 200, init);
    if (!session.kHex) throw new Error('no K — call fetchK first');

    const sk = computeSk(init.challenge, session.kHex);
    expect200(
      'iserver/auth/ssodh/response',
      await api.post(session, portalUrl(session, 'iserver/auth/ssodh/response'), { response: sk }),
    );
  }
  throw new Error(`brokerageAuthenticate: not authenticated after ${maxLoops} loops`);
}

export async function tickle(session) {
  return expect200('tickle', await api.get(session, portalUrl(session, 'tickle')));
}

// Idempotently bring the iserver brokerage tier up. Safe to call any
// time before an action that needs it (order placement, secdef/search,
// iserver/accounts, etc.). The bridge naturally drops after some idle
// period; this re-runs the SSODH handshake to bring it back.
export async function ensureBrokerage(session, { force = false } = {}) {
  if (!force) {
    const status = expect200(
      'iserver/auth/status',
      await api.get(session, portalUrl(session, 'iserver/auth/status')),
    );
    if (status.authenticated && status.connected && status.competing === false) return status;
  }
  // We need userName + K. Both come from validate + ssodh/st.
  if (!session.userName) await validateSso(session);
  await fetchK(session);
  return brokerageAuthenticate(session);
}

// One-shot: assumes the web cookies (XYZAB etc.) are already in session.
// Runs the post-login pipeline and persists.
//
// `sso/validate` is the only hard requirement — it pins USER_ID into the
// session and proves the web cookies are good. The SSODH brokerage
// handshake is best-effort: it's only needed to *place orders*, and is
// not available for accounts in pending-application state. Portfolio /
// positions / cash endpoints work fine without it.
export async function establishSession(session) {
  await validateSso(session);
  // Persist as soon as we have a valid session — even if brokerage
  // fails later, positions.js still works.
  await persist(session);

  try {
    await fetchK(session);
    await publishTstToken(session);
    const status = await brokerageAuthenticate(session);
    await persist(session);
    return { ...status, brokerage: 'ok' };
  } catch (e) {
    // Re-fetch status so the caller has *something* to report.
    let status = null;
    try {
      const r = await api.get(session, portalUrl(session, 'iserver/auth/status'));
      if (r.status === 200) status = r.data;
    } catch { /* swallow */ }
    return {
      ...(status || { authenticated: false, competing: false, connected: false }),
      brokerage: 'unavailable',
      brokerageError: e.message,
    };
  }
}
