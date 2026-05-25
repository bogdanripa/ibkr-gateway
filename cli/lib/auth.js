// Re-implements the post-login pipeline that GatewayHttpProxy /
// ClientPortalService / SsoService run inside the Java gateway. See
// docs/cpg-protocol.md §3 for the flow this mirrors.

import { api, persist } from './api.js';
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
  const res = await api.get(session, '/v1/api/sso/validate?gw=1');
  const data = expect200('sso/validate', res);
  if (data && typeof data === 'object') {
    if (data.USER_ID) session.userId = data.USER_ID;
    if (data.USER_NAME) session.userName = data.USER_NAME;
  }
  return data;
}

// SsoService.ssoDHInit + setK — fetches the shared K from the server.
export async function fetchK(session) {
  expect200('ssodh/init', await api.get(session, '/v1/api/ssodh/init'));
  const st = expect200('ssodh/st', await api.get(session, '/v1/api/ssodh/st'));
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
  const url = `/sso/Authenticator?ACTION=PUBLISH_TST&RESP_TYPE=JSON&DEVICE_ID=${encodeURIComponent(session.deviceId)}`;
  try { await api.get(session, url); } catch (e) { /* non-fatal */ }
}

// ClientPortalService.getStatus / processAuthStatus / authenticateBrokerage
// / ssoDHResponse — the brokerage SSODH challenge/response dance.
export async function brokerageAuthenticate(session, { maxLoops = 8 } = {}) {
  for (let loop = 0; loop < maxLoops; loop++) {
    const status = expect200(
      'iserver/auth/status',
      await api.get(session, '/v1/api/iserver/auth/status'),
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
      await api.get(session, '/v1/api/iserver/auth/status').then(() =>
        api.post(session, '/v1/api/iserver/auth/ssodh/init', post)),
    );

    if (init.authenticated) continue;
    if (init.wait) { await SLEEP_MS(5000); continue; }
    if (init.error) throw new AuthError('iserver/auth/ssodh/init', 200, init);
    if (!init.challenge) throw new AuthError('iserver/auth/ssodh/init', 200, init);
    if (!session.kHex) throw new Error('no K — call fetchK first');

    const sk = computeSk(init.challenge, session.kHex);
    expect200(
      'iserver/auth/ssodh/response',
      await api.post(session, '/v1/api/iserver/auth/ssodh/response', { response: sk }),
    );
  }
  throw new Error(`brokerageAuthenticate: not authenticated after ${maxLoops} loops`);
}

export async function tickle(session) {
  return expect200('tickle', await api.get(session, '/v1/api/tickle'));
}

// One-shot: assumes the web cookies (XYZAB etc.) are already in session.
// Runs the entire post-login pipeline and persists.
export async function establishSession(session) {
  await validateSso(session);
  await fetchK(session);
  await publishTstToken(session);
  const status = await brokerageAuthenticate(session);
  await persist(session);
  return status;
}
