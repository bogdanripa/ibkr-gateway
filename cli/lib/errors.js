// Translate IbkrError + raw exceptions into human-readable CLI messages.
// CLI-only — the module surfaces { stage, status, body, message } and
// lets each consumer decide how to phrase it.

const STATUS_HINTS = {
  400: 'IBKR rejected the request as invalid',
  401: 'not authenticated (your session may have expired — sign in again)',
  403: 'access denied for this account / endpoint',
  404: 'not found — check the id you supplied',
  408: 'IBKR took too long to respond — try again',
  409: 'conflict (another session may be active for this user)',
  429: 'rate-limited by IBKR — wait a few seconds and retry',
  500: 'IBKR returned an internal server error (often: brokerage tier ' +
       'still warming up, or no data for this account / id)',
  502: 'IBKR upstream is unreachable — try again in a moment',
  503: 'IBKR service unavailable — try again in a moment',
  504: 'IBKR gateway timeout — try again',
  601: 'IBKR session expired — sign in again',
};

const STAGE_HINTS = {
  'no-account-selected': 'you have multiple accounts — pick one via Accounts → Set current',
  'no-accounts': 'this user has no accessible accounts',
  'sso/validate': 'session validation failed — sign in again',
};

export function humanError(e) {
  if (!e) return 'unknown error';
  const stage = e.stage;
  const status = e.status;
  // Specific stage messages always win.
  if (stage && STAGE_HINTS[stage]) return STAGE_HINTS[stage];

  // Pull a clean tail off the body if it's an IBKR JSON error.
  let detail = '';
  const body = e.body;
  if (body && typeof body === 'object' && body.error) {
    detail = String(body.error);
  } else if (typeof body === 'string' && body && body.length < 240) {
    detail = body;
  }

  // Prefer IBKR's own detail message when present — they're usually
  // more specific than our generic status-code paraphrase ("Order 123
  // is not found" beats "IBKR service unavailable").
  if (detail) return detail;
  if (status && STATUS_HINTS[status]) return STATUS_HINTS[status];
  // No status mapping — return the message but strip the bare "HTTP NNN"
  // prefix our module sometimes emits.
  const msg = (e.message || String(e)).replace(/\s*→\s*HTTP \d+:?\s*/g, ': ').trim();
  return detail && !msg.includes(detail) ? `${msg} (${detail})` : msg;
}
