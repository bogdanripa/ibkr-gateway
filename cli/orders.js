#!/usr/bin/env node
// `node cli/orders.js [list|status|cancel] ...`
//
//   list                              — print the live order book
//   list --status Filled,PreSubmitted — filter by status (comma list)
//   status <orderId>                  — single-order detail
//   cancel <orderId> [--account ID]   — cancel an order
//
// Reads + writes session at ~/.ibkr-cli/session.json.

import { argv, exit } from 'node:process';
import { IbkrClient } from './lib/client.js';
import { loadState, saveState, sessionPath } from './lib/session-file.js';

const sub = argv[2] || 'list';
const flag = (n) => { const i = argv.indexOf('--' + n); return i < 0 ? undefined : argv[i + 1]; };

const state = await loadState();
if (!state) { console.error(`no session at ${sessionPath()} — run \`node cli/login.js\` first`); exit(2); }
const client = new IbkrClient({ state });
if (!client.isSignedIn()) { console.error('session has no cookies — re-run login'); exit(2); }

try {
  await client.ensureBrokerage();
  await saveState(client.getState());
} catch (e) {
  console.error('✗ brokerage tier unavailable: ' + (e.message || e));
  exit(1);
}

function pad(s, n, right = false) {
  s = String(s ?? '');
  return s.length >= n ? s.slice(0, n) : (right ? s.padStart(n) : s.padEnd(n));
}

try {
  if (sub === 'list') {
    const statusFilter = flag('status') ? String(flag('status')).split(',').map((s) => s.trim()) : undefined;
    const orders = await client.getOrders({ status: statusFilter });
    if (!orders.length) { console.log('(no orders)'); exit(0); }
    console.log(
      pad('OrderId', 14) + '  ' + pad('Ticker', 8) + '  ' + pad('Side', 5) + '  ' +
      pad('Fills', 10, true) + '  ' + pad('Status', 18) + '  ' + 'Desc',
    );
    console.log('-'.repeat(120));
    for (const o of orders) {
      console.log(
        pad(o.orderId, 14) + '  ' + pad(o.ticker, 8) + '  ' + pad(o.side, 5) + '  ' +
        pad(o.sizeAndFills || `${o.filledQuantity ?? 0}/${o.totalSize ?? 0}`, 10, true) + '  ' +
        pad(o.status, 18) + '  ' + (o.orderDesc || ''),
      );
    }
    exit(0);
  }

  if (sub === 'status') {
    const orderId = argv[3];
    if (!orderId) { console.error('usage: orders status <orderId>'); exit(2); }
    console.log(JSON.stringify(await client.getOrderStatus(orderId), null, 2));
    exit(0);
  }

  if (sub === 'cancel') {
    const orderId = argv[3];
    if (!orderId) { console.error('usage: orders cancel <orderId> [--account ID]'); exit(2); }
    const res = await client.cancelOrder({ orderId, accountId: flag('account') });
    console.log(JSON.stringify(res, null, 2));
    exit(0);
  }
} catch (e) {
  console.error('✗ ' + (e.message || e));
  exit(1);
}

console.error(`unknown subcommand '${sub}'`);
console.error('usage: orders list | status <id> | cancel <id>');
exit(2);
