// Place orders against the IBKR iserver tier.
//
// IBKR's order-placement endpoint is a two-step protocol:
//
//   POST /iserver/account/{accountId}/orders   { orders: [order, ...] }
//
// The first response can be one of:
//   · A list of `{id, message, isSuppressed, messageIds}` confirmation
//     prompts ("are you sure?", margin warnings, after-hours warnings,
//     etc.). For each, we reply with:
//       POST /iserver/reply/{id}   { confirmed: true }
//     This can chain (one confirmation produces another) — loop until
//     we get back a final `{order_id, order_status, ...}` array.
//   · A list of `{order_id, local_order_id, order_status, ...}` — done.
//
// The decompiled CPG doesn't model orders directly (it just proxies),
// so this routine follows IBKR's published cpwebapi spec.

import { api, portalUrl } from './api.js';

const MAX_CONFIRM_LOOPS = 10;

// Pull a list out of a response body that may be either a raw array
// (`[…]`) or an object wrapping it (`{secdef:[…]}` / `{data:[…]}`).
function asArray(x) {
  if (Array.isArray(x)) return x;
  if (x && typeof x === 'object') {
    if (Array.isArray(x.secdef)) return x.secdef;
    if (Array.isArray(x.data)) return x.data;
    if (Array.isArray(x.results)) return x.results;
  }
  return [];
}

// Resolve a stock symbol → conid via /iserver/secdef/search.
// Returns the first STK match (or first result if no STK tag is set).
export async function resolveConid(session, symbol) {
  const res = await api.get(
    session,
    portalUrl(session, `iserver/secdef/search?symbol=${encodeURIComponent(symbol)}`),
  );
  if (res.status !== 200) {
    throw new Error(`secdef/search ${symbol} → HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  }
  const list = asArray(res.data);
  if (!list.length) throw new Error(`no security found for symbol ${symbol}`);

  // Prefer rows that explicitly list STK in their sections.
  const stk = list.find((r) =>
    Array.isArray(r.sections) && r.sections.some((s) => s.secType === 'STK'),
  ) || list[0];

  const conid = Number(stk.conid);
  if (!conid) throw new Error(`secdef/search ${symbol} returned no conid: ${JSON.stringify(stk).slice(0, 200)}`);
  return {
    conid,
    description: stk.companyHeader || stk.description || stk.companyName || symbol,
  };
}

// Place a single order. Returns the final iserver response (an array of
// {order_id, order_status, …}) after walking all confirmation prompts.
//
// Required:
//   accountId   — e.g. "DUQ443672"
//   side        — "BUY" | "SELL"
//   quantity    — positive number
//   orderType   — "MKT" | "LMT" | "STP" | "STP_LIMIT" | "MIT" | …
//   one of:     conid   — pre-resolved contract id
//               symbol  — stock ticker; we'll resolve to conid via secdef/search
// Optional:
//   limitPrice  — required for LMT and STP_LIMIT
//   stopPrice   — required for STP / STP_LIMIT
//   tif         — "DAY" (default) | "GTC" | "IOC" | "OPG"
//   outsideRth  — bool, default false
//   onConfirm   — async (msg) => bool. Defaults to () => true.
//                 Use this to e.g. log/prompt before auto-confirming.
//   onProgress  — callback(string), default no-op.
export async function placeOrder(session, params) {
  const {
    accountId,
    side,
    quantity,
    orderType,
    limitPrice,
    stopPrice,
    tif = 'DAY',
    outsideRth = false,
    onConfirm = async () => true,
    onProgress = () => {},
  } = params;

  if (!accountId) throw new Error('placeOrder: accountId required');
  if (!side || !/^(BUY|SELL)$/i.test(side)) throw new Error('placeOrder: side must be BUY or SELL');
  if (!quantity || quantity <= 0) throw new Error('placeOrder: quantity must be > 0');
  if (!orderType) throw new Error('placeOrder: orderType required');
  if (/^LMT|^STP_LIMIT/i.test(orderType) && limitPrice == null) {
    throw new Error(`placeOrder: orderType ${orderType} requires limitPrice`);
  }
  if (/^STP/i.test(orderType) && stopPrice == null && orderType.toUpperCase() !== 'STP_LIMIT') {
    // STP needs stopPrice; STP_LIMIT needs both (handled by the previous check too).
    throw new Error(`placeOrder: orderType ${orderType} requires stopPrice`);
  }

  // Resolve conid.
  let { conid, symbol } = params;
  let description = '';
  if (!conid) {
    if (!symbol) throw new Error('placeOrder: pass either conid or symbol');
    onProgress(`resolving conid for ${symbol}`);
    const r = await resolveConid(session, symbol);
    conid = r.conid;
    description = r.description;
    onProgress(`  → ${symbol} conid=${conid} (${description})`);
  }

  const order = {
    conid: Number(conid),
    orderType: orderType.toUpperCase(),
    side: side.toUpperCase(),
    quantity: Number(quantity),
    tif: tif.toUpperCase(),
    outsideRth: !!outsideRth,
  };
  if (limitPrice != null) order.price = Number(limitPrice);
  if (stopPrice != null) order.auxPrice = Number(stopPrice);

  onProgress(`POST /iserver/account/${accountId}/orders  body=${JSON.stringify({ orders: [order] })}`);
  let res = await api.post(
    session,
    portalUrl(session, `iserver/account/${encodeURIComponent(accountId)}/orders`),
    { orders: [order] },
  );
  if (res.status !== 200) {
    throw new Error(`order POST → HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  }

  // Walk confirmation prompts. Each prompt looks like:
  //   { id, message: ["text"], isSuppressed: false, messageIds: ["o354"] }
  // We must reply with POST /iserver/reply/{id} {confirmed: true} (or
  // false to abort). The next response may be either another prompt
  // array or the final order-status array.
  let body = res.data;
  for (let i = 0; i < MAX_CONFIRM_LOOPS; i++) {
    const arr = Array.isArray(body) ? body : null;
    if (!arr || !arr.length) break;
    const first = arr[0];
    // Final response shape — has order_id/order_status, not id+message.
    if (first.order_id || first.order_status) return arr;
    if (!first.id || !first.message) break; // unrecognised, return as-is

    const ok = await onConfirm({
      id: first.id,
      message: Array.isArray(first.message) ? first.message.join('\n') : String(first.message),
      messageIds: first.messageIds || [],
    });
    onProgress(`reply ${first.id} → ${ok ? 'confirmed' : 'cancelled'}`);
    res = await api.post(
      session,
      portalUrl(session, `iserver/reply/${encodeURIComponent(first.id)}`),
      { confirmed: !!ok },
    );
    if (res.status !== 200) {
      throw new Error(`reply ${first.id} → HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    }
    if (!ok) return [{ order_status: 'cancelled-by-caller', reply: first }];
    body = res.data;
  }

  // Either we ran out of loops or the body is something unexpected; return it.
  return Array.isArray(body) ? body : [body];
}
