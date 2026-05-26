// MCP (Model Context Protocol) server.
//
// Mounted at /mcp. Speaks the JSON-RPC 2.0 dialect MCP uses over plain
// HTTP — a client POSTs one JSON-RPC request and gets one JSON-RPC
// response in the body. We do NOT implement the SSE streaming
// transport; none of our tools are long-running enough to benefit.
//
// Auth: bearer API key in `Authorization: Bearer ibkr_…` (same format
// the console issues per-connection). The key resolves to one IBKR
// connection — that's the scope every tool call operates against.
//
// Every tool maps to `withClient(connectionId, c => c.someMethod(args))`,
// so the MCP server inherits the stateless session-restore + tickle +
// re-signIn behaviour of src/connection.ts.

import { Router, type Request, type Response, type NextFunction } from "express";
import { findConnectionByApiKey } from "./apikeys.js";
import { findConnectionByOAuthToken } from "./oauth.js";
import { withClient, ConnectionNotFoundError, CredentialRejectedError, EmailVerificationNeededError } from "./connection.js";
import { logError } from "./logging.js";
import { config } from "./config.js";
import type { IbkrClient } from "../lib/ibkr/index.js";

export const mcp = Router();

// JSON body parser (mirrors the console api's manual one — we want a
// raw-buffer read so we can return a JSON-RPC parse error, not Express'
// default text/plain "Bad JSON").
mcp.use((req, _res, next) => {
  if (req.method !== "POST") return next();
  let buf = "";
  req.setEncoding("utf8");
  req.on("data", (c) => { buf += c; });
  req.on("end", () => {
    try { req.body = buf ? JSON.parse(buf) : {}; next(); }
    catch { req.body = { __parseError: true }; next(); }
  });
});

// ---------------------------------------------------------------------------
// Auth middleware (Bearer api key → connection id on req.mcp)
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      mcp?: {
        connectionId: string;
        scope: "read" | "write";
        source: "apikey" | "oauth";
        apiKeyId: string | null;
        oauthTokenId: string | null;
        label: string | null;
      };
    }
  }
}

mcp.use(async (req, res, next) => {
  // GET /mcp returns the server-info JSON so curling the URL gives
  // something useful (no auth needed for it).
  if (req.method === "GET") return next();

  const raw = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!raw) {
    // Advertise the AS so MCP clients can discover where to authorize.
    // RFC 6750 §3 form for the WWW-Authenticate header.
    res.setHeader(
      "WWW-Authenticate",
      `Bearer realm="ibkr-gateway", resource_metadata="${config.publicOrigin}/.well-known/oauth-protected-resource"`,
    );
    rpcError(res, null, -32001, "missing Authorization: Bearer <token>", 401);
    return;
  }
  try {
    // Try OAuth token first (new), API key second (legacy / CI use).
    const oauth = await findConnectionByOAuthToken(raw);
    if (oauth) {
      req.mcp = {
        connectionId: oauth.connection_id,
        scope: oauth.scope,
        source: "oauth",
        apiKeyId: null,
        oauthTokenId: oauth.id,
        label: null,
      };
      return next();
    }
    const apikey = await findConnectionByApiKey(raw);
    if (apikey) {
      req.mcp = {
        connectionId: apikey.ibkr_connection_id,
        scope: "write",      // legacy API keys are full-access
        source: "apikey",
        apiKeyId: apikey.id,
        oauthTokenId: null,
        label: apikey.label,
      };
      return next();
    }
    res.setHeader(
      "WWW-Authenticate",
      `Bearer realm="ibkr-gateway", error="invalid_token", resource_metadata="${config.publicOrigin}/.well-known/oauth-protected-resource"`,
    );
    rpcError(res, null, -32001, "invalid or revoked credential", 401);
  } catch (e) {
    rpcError(res, null, -32603, `auth lookup failed: ${(e as Error).message}`, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /mcp — server-info (no auth)
// ---------------------------------------------------------------------------

mcp.get("/", (_req, res) => {
  res.json({
    name: "ibkr-gateway",
    description:
      "MCP server fronting an Interactive Brokers connection. Bearer auth " +
      "using an `ibkr_…` API key issued from the console. POST JSON-RPC 2.0 " +
      "requests to this URL; supported methods: initialize, ping, " +
      "notifications/initialized, tools/list, tools/call.",
    transport: "http+json (single-request POST)",
    authentication: "bearer-token",
  });
});

// ---------------------------------------------------------------------------
// POST /mcp — JSON-RPC dispatch
// ---------------------------------------------------------------------------

mcp.post("/", async (req, res) => {
  const body = req.body as { __parseError?: boolean; jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
  if (body?.__parseError) {
    rpcError(res, null, -32700, "parse error: body is not valid JSON", 400);
    return;
  }
  if (body?.jsonrpc !== "2.0" || typeof body.method !== "string") {
    rpcError(res, body?.id ?? null, -32600, "invalid request: expected {jsonrpc:'2.0', method:string, id?, params?}", 400);
    return;
  }
  const id = body.id ?? null;
  const params = (body.params ?? {}) as Record<string, unknown>;

  try {
    switch (body.method) {
      case "initialize":
        return rpcOk(res, id, initializeResult());
      case "ping":
        return rpcOk(res, id, {});
      case "notifications/initialized":
        // JSON-RPC notification (no id usually); ack with empty body.
        return res.status(204).end();
      case "tools/list":
        return rpcOk(res, id, { tools: listToolDescriptors(req.mcp!.scope) });
      case "tools/call": {
        const name = String(params.name ?? "");
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const tool = TOOLS[name];
        if (!tool) {
          return rpcOk(res, id, {
            isError: true,
            content: [{ type: "text", text: `unknown tool: ${name}` }],
          });
        }
        // Enforce scope: read-only callers can't invoke mutating tools.
        // -32004 is our chosen application code for "out of scope"; the
        // 2025 MCP spec leaves -32000..-32099 free for server-defined.
        if (tool.mutating && req.mcp!.scope === "read") {
          return rpcError(
            res, id, -32004,
            `tool '${name}' requires the 'write' scope; this client was granted 'read' only. The user must re-authorize and select 'Read & write' on the consent screen.`,
            403,
          );
        }
        const result = await callTool(tool, args, req);
        return rpcOk(res, id, result);
      }
      default:
        return rpcError(res, id, -32601, `method not supported: ${body.method}`);
    }
  } catch (e) {
    return rpcError(res, id, -32603, `internal error: ${(e as Error).message}`, 500);
  }
});

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function rpcOk(res: Response, id: unknown, result: unknown): void {
  res.json({ jsonrpc: "2.0", id, result });
}
function rpcError(res: Response, id: unknown, code: number, message: string, http = 400): void {
  res.status(http).json({ jsonrpc: "2.0", id, error: { code, message } });
}

// ---------------------------------------------------------------------------
// Server capabilities / initialize result
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = "2025-06-18"; // current MCP spec version we target

function initializeResult() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} }, // we expose tools only (no resources / prompts)
    serverInfo: {
      name: "ibkr-gateway",
      version: "0.1.0",
    },
    instructions:
      "Tools call into an Interactive Brokers session scoped to the connection " +
      "associated with your API key. Account-scoped tools default to the connection's " +
      "current account (set via `set_current_account` if there are multiple).",
  };
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

interface ToolDef {
  description: string;
  inputSchema: object;          // JSON Schema for the args
  handler: (args: Record<string, unknown>, client: IbkrClient) => Promise<unknown>;
  /** Some tools don't need a fully-authenticated brokerage tier (e.g.
   * get_accounts only needs portfolio scope). Most do — declare true. */
  needsBrokerage?: boolean;
  /** True if the tool changes state (orders, account selection, session).
   * Hidden from tools/list and rejected on tools/call when the caller
   * holds a read-only OAuth scope. Legacy API keys are always write. */
  mutating?: boolean;
}

const TOOLS: Record<string, ToolDef> = {
  get_accounts: {
    description: "List every IBKR sub-account on the connection.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_a, c) => c.getAccounts(),
  },
  get_current_account: {
    description: "Get the implicit account id used when an account-scoped tool is called without one.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_a, c) => ({ current_account_id: c.getCurrentAccount() }),
  },
  set_current_account: {
    description: "Pin which account subsequent account-scoped tools target. The selection persists in the connection's session.",
    inputSchema: {
      type: "object",
      required: ["account_id"],
      properties: { account_id: { type: "string", description: "IBKR sub-account id (e.g. DUQ443672)" } },
      additionalProperties: false,
    },
    handler: async (a, c) => ({ current_account_id: await c.setCurrentAccount(String(a.account_id)) }),
    mutating: true,
  },

  get_portfolio: {
    description: "Snapshot of an account: stocks, options, other positions, and cash ledger.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "Optional override; default = current account." },
      },
      additionalProperties: false,
    },
    handler: async (a, c) => c.getPositions(a.account_id ? String(a.account_id) : undefined),
  },
  get_cash: {
    description: "Cash ledger (one row per currency, plus a BASE row that sums to the account base currency).",
    inputSchema: {
      type: "object",
      properties: { account_id: { type: "string" } },
      additionalProperties: false,
    },
    handler: async (a, c) => c.getCash(a.account_id ? String(a.account_id) : undefined),
  },

  search_security: {
    description: "Search IBKR's security master by ticker or company name. Returns up to ~30 candidates with conid + exchange + secTypes.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Ticker or company name (e.g. 'AAPL' or 'Apple')." },
        by_name: { type: "boolean", default: false, description: "Search by company name (fuzzy). Default is exact ticker." },
      },
      additionalProperties: false,
    },
    handler: async (a, c) => c.searchSecurity(String(a.query), { name: !!a.by_name }),
    needsBrokerage: true,
  },
  get_quote: {
    description: "Snapshot quote (last, bid, ask, day H/L, 52w H/L) for a single contract.",
    inputSchema: {
      type: "object",
      required: ["conid"],
      properties: { conid: { type: "integer" } },
      additionalProperties: false,
    },
    handler: async (a, c) => c.getQuote(Number(a.conid)),
    needsBrokerage: true,
  },
  get_history: {
    description: "Historical OHLCV bars for a contract.",
    inputSchema: {
      type: "object",
      required: ["conid"],
      properties: {
        conid: { type: "integer" },
        period: { type: "string", default: "1y", description: "1d|5d|1w|1m|3m|6m|1y|2y|5y" },
        bar:    { type: "string", default: "1d", description: "1min|5min|15min|30min|1h|2h|4h|1d|1w|1m" },
        outside_rth: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
    handler: async (a, c) => c.getHistory(Number(a.conid), {
      period: a.period ? String(a.period) : undefined,
      bar:    a.bar ? String(a.bar) : undefined,
      outsideRth: !!a.outside_rth,
    }),
    needsBrokerage: true,
  },
  get_change: {
    description: "First→last close change over a period (e.g. 1d / 1w / 1m / 1y). Returns null if not enough bars.",
    inputSchema: {
      type: "object",
      required: ["conid"],
      properties: {
        conid: { type: "integer" },
        period: { type: "string", default: "1y" },
        bar:    { type: "string", default: "1d" },
      },
      additionalProperties: false,
    },
    handler: async (a, c) => c.getChange(Number(a.conid), {
      period: a.period ? String(a.period) : undefined,
      bar:    a.bar ? String(a.bar) : undefined,
    }),
    needsBrokerage: true,
  },

  get_orders: {
    description: "Live order book for the connection, optionally filtered by status.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description: "PreSubmitted | Submitted | Filled | Cancelled | Rejected | Inactive (string or array of)",
        },
      },
      additionalProperties: false,
    },
    handler: async (a, c) => c.getOrders({ status: a.status as string | string[] | undefined }),
    needsBrokerage: true,
  },
  get_order_status: {
    description: "Detailed status of a single order (by orderId).",
    inputSchema: {
      type: "object",
      required: ["order_id"],
      properties: { order_id: { type: ["string", "integer"] } },
      additionalProperties: false,
    },
    handler: async (a, c) => c.getOrderStatus(String(a.order_id)),
    needsBrokerage: true,
  },
  place_order: {
    description:
      "Place a single equity order. IBKR confirmation prompts (size/price warnings, after-hours, etc.) are auto-confirmed; if you need a more cautious flow, place a LMT well off the market and cancel afterwards. Either `conid` OR `symbol` must be supplied.",
    inputSchema: {
      type: "object",
      required: ["side", "quantity", "order_type"],
      properties: {
        account_id: { type: "string" },
        conid:      { type: "integer" },
        symbol:     { type: "string", description: "Ticker; resolved via secdef/search (prefers STK match)." },
        side:       { type: "string", enum: ["BUY", "SELL"] },
        quantity:   { type: "number", minimum: 0.0001 },
        order_type: { type: "string", enum: ["MKT", "LMT", "STP", "STP_LIMIT", "MIT"] },
        limit_price:{ type: "number", description: "Required for LMT / STP_LIMIT." },
        stop_price: { type: "number", description: "Required for STP / STP_LIMIT." },
        tif:        { type: "string", enum: ["DAY", "GTC", "IOC", "OPG"], default: "DAY" },
        outside_rth:{ type: "boolean", default: false },
      },
      additionalProperties: false,
    },
    handler: async (a, c) => c.placeOrder({
      accountId:  a.account_id ? String(a.account_id) : undefined,
      conid:      a.conid != null ? Number(a.conid) : undefined,
      symbol:     a.symbol ? String(a.symbol) : undefined,
      side:       String(a.side).toUpperCase() as "BUY" | "SELL",
      quantity:   Number(a.quantity),
      orderType:  String(a.order_type).toUpperCase(),
      limitPrice: a.limit_price != null ? Number(a.limit_price) : undefined,
      stopPrice:  a.stop_price != null ? Number(a.stop_price) : undefined,
      tif:        (a.tif ? String(a.tif).toUpperCase() : "DAY") as "DAY",
      outsideRth: !!a.outside_rth,
      onConfirm:  async () => true,
    }),
    needsBrokerage: true,
    mutating: true,
  },
  cancel_order: {
    description: "Cancel a working order by id.",
    inputSchema: {
      type: "object",
      required: ["order_id"],
      properties: {
        order_id:   { type: ["string", "integer"] },
        account_id: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: async (a, c) => c.cancelOrder({
      orderId:   String(a.order_id),
      accountId: a.account_id ? String(a.account_id) : undefined,
    }),
    needsBrokerage: true,
    mutating: true,
  },
};

function toStructuredContent(result: unknown): Record<string, unknown> | null {
  if (result == null) return null;
  if (Array.isArray(result)) return { value: result };
  if (typeof result === "object") return result as Record<string, unknown>;
  // Scalars (string / number / boolean) — wrap so the shape is a dict.
  return { value: result };
}

function listToolDescriptors(scope: "read" | "write") {
  return Object.entries(TOOLS)
    .filter(([, t]) => scope === "write" || !t.mutating)
    .map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
}

// ---------------------------------------------------------------------------
// Tool execution — wraps withClient + maps domain errors to MCP errors.
// ---------------------------------------------------------------------------

async function callTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  req: Request
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean; structuredContent?: unknown }> {
  const connectionId = req.mcp!.connectionId;
  try {
    const result = await withClient(connectionId, async (client) => {
      if (tool.needsBrokerage) await client.ensureBrokerage();
      return tool.handler(args, client);
    });
    // MCP spec: tools return { content: [{type:'text', text:...}] }. We
    // serialise the structured result as JSON in a text block so clients
    // get both: human-readable for chat surfaces, JSON-parseable for
    // programmatic ones. We also include structuredContent (a 2025-spec
    // field) so clients that prefer structured data don't have to parse.
    //
    // structuredContent MUST be a JSON object per the spec — Claude.ai's
    // client enforces this with a strict dict-type check. If a tool
    // returns an array or scalar (e.g. search_security → array of hits),
    // wrap it under `{ value }` so the shape is always an object.
    const text = result == null ? "ok" : JSON.stringify(result, null, 2);
    const structured = toStructuredContent(result);
    return {
      content: [{ type: "text" as const, text }],
      ...(structured ? { structuredContent: structured } : {}),
    };
  } catch (e) {
    const msg = humanError(e);
    // Persist tool-call failures (anything that escaped withClient or
    // the tool handler) for later review. Args are summarised — never
    // log raw values that might contain anything sensitive.
    logError({
      source: "mcp",
      connectionId,
      apiKeyId: req.mcp?.apiKeyId,
      code: (e as Error & { stage?: string; status?: number })?.stage
        ?? ((e as Error & { status?: number })?.status ? `HTTP_${(e as Error & { status?: number }).status}` : null),
      error: e,
      context: { tool: (req.body as { params?: { name?: string } })?.params?.name ?? null, arg_keys: Object.keys(args) },
    }).catch(() => undefined);
    return {
      isError: true,
      content: [{ type: "text" as const, text: msg }],
    };
  }
}

function humanError(e: unknown): string {
  if (e instanceof ConnectionNotFoundError) return `connection not found (it may have been deleted)`;
  if (e instanceof CredentialRejectedError) return `IBKR rejected the stored credentials — re-test the connection from the console`;
  if (e instanceof EmailVerificationNeededError) return `IBKR's new-device verification is required. Open the web console and click Test on this connection to enter the emailed code, then retry.`;
  if (e instanceof Error) {
    const m = e as Error & { stage?: string; status?: number; body?: { error?: string } };
    const detail = m.body?.error;
    if (detail) return detail;
    if (m.status) return `IBKR returned HTTP ${m.status}: ${m.message}`;
    return m.message;
  }
  return String(e);
}

// ---------------------------------------------------------------------------
// Error sink (last middleware).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
mcp.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const e = err as Error;
  logError({
    source: "mcp",
    connectionId: req.mcp?.connectionId ?? null,
    apiKeyId: req.mcp?.apiKeyId ?? null,
    code: "MCP_INTERNAL",
    error: err,
    context: { method: (req.body as { method?: string })?.method ?? null },
  }).catch(() => undefined);
  res.status(500).json({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32603, message: e.message ?? "internal error" },
  });
});
