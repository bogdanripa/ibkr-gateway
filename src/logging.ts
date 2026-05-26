// Production error logging.
//
// logError(...) persists a structured row to Firestore (ibkr_errors)
// AND prints a one-line JSON summary to stderr so the systemd journal
// still has it for live tailing. Best-effort: if the Firestore write
// fails we swallow the inner error (the journal still has the
// original) so the caller's flow isn't disrupted.
//
// SECURITY: callers must not pass credential plaintext or session
// cookies into `context`. The doc is queryable by the connection's
// owner via /console/api/errors.

import { FieldValue, Timestamp } from "@google-cloud/firestore";
import { errorsCol, connectionsCol, type ErrorDoc } from "./firestore.js";

export interface LogErrorOptions {
  source: ErrorDoc["source"];
  connectionId?: string | null;
  accountId?: string | null;       // override; otherwise looked up from connection
  apiKeyId?: string | null;
  code?: string | null;
  error: unknown;
  context?: Record<string, unknown> | null;
}

const RETENTION_DAYS = 14;
const MAX_MESSAGE = 2_000;
const MAX_STACK = 6_000;
const MAX_CONTEXT_JSON = 4_000;

export async function logError(opts: LogErrorOptions): Promise<void> {
  const e = opts.error as Error & { stage?: string; status?: number };
  const code = opts.code
    ?? (e && (e as Error & { code?: string }).code)
    ?? (e?.stage)
    ?? (e?.status ? `HTTP_${e.status}` : null)
    ?? null;
  const message = clip(String(e?.message ?? e ?? "unknown"), MAX_MESSAGE);
  const stack = e?.stack ? clip(e.stack, MAX_STACK) : null;
  const context = clipContext(opts.context ?? null);

  // Always log to stderr first — Firestore write is best-effort.
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: "error",
    source: opts.source,
    connection_id: opts.connectionId ?? null,
    api_key_id: opts.apiKeyId ?? null,
    code,
    message,
  }));

  // Resolve account_id when only connection_id was supplied so the
  // console viewer can filter by owner without an extra join.
  let accountId = opts.accountId ?? null;
  if (!accountId && opts.connectionId) {
    try {
      const snap = await connectionsCol.doc(opts.connectionId).get();
      if (snap.exists) accountId = (snap.get("account_id") as string) ?? null;
    } catch {
      // Non-fatal — accountId stays null.
    }
  }

  const now = Date.now();
  const expiresAt = Timestamp.fromMillis(now + RETENTION_DAYS * 86_400_000);
  try {
    await errorsCol.add({
      ts: FieldValue.serverTimestamp() as unknown as Timestamp,
      source: opts.source,
      account_id: accountId,
      connection_id: opts.connectionId ?? null,
      api_key_id: opts.apiKeyId ?? null,
      code,
      message,
      stack,
      context,
      expires_at: expiresAt,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("logError: Firestore write failed:", (err as Error).message);
  }
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function clipContext(ctx: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!ctx) return null;
  try {
    const json = JSON.stringify(ctx);
    if (json.length <= MAX_CONTEXT_JSON) return ctx;
    // Too big — keep top-level keys but stringify and clip the values.
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(ctx)) {
      const v = ctx[k];
      const vJson = typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
      out[k] = clip(vJson, 200);
    }
    return out;
  } catch {
    return null;
  }
}
