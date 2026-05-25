// End-to-end smoke test for §11 step 3 (Gateway wrapper).
//
// Drives one IBeam container against the credentials stored for a single
// ibkr_connection. Demonstrates the friendly 2FA / credential-rejected
// error paths so the operator sees what a real failure looks like.
//
// Usage:
//   tsx scripts/test-gateway.ts <connectionId> [hostPort]
//
// Default port: GATEWAY_PORT_MIN from config (5001).

import { config } from "../src/config.js";
import { spawnGateway, reapGateway } from "../src/gateway.js";
import { IbkrError } from "../src/errors.js";

const connectionId = process.argv[2];
const hostPort = Number(process.argv[3] ?? config.gatewayPortMin);

if (!connectionId) {
  console.error("Usage: tsx scripts/test-gateway.ts <connectionId> [hostPort]");
  process.exit(2);
}

async function main() {
  console.log(`Spawning Gateway for connection=${connectionId} on port=${hostPort}…`);
  console.log(`(timeout=${config.spawnLoginTimeoutMs}ms; image=${config.ibeamImage})`);

  try {
    const handle = await spawnGateway(connectionId, hostPort);
    console.log(`\nAUTHENTICATED.`);
    console.log(`  container : ${handle.containerName}`);
    console.log(`  baseUrl   : ${handle.baseUrl}`);
    console.log(`  port      : ${handle.hostPort}`);
    console.log(`\nLeaving container running. To tear down:`);
    console.log(`  tsx scripts/reap-gateway.ts ${connectionId}`);
  } catch (err) {
    if (err instanceof IbkrError) {
      console.error(`\n${err.code}: ${err.message}`);
      if (err.remediation) {
        console.error(`\n${err.remediation}`);
      }
      process.exit(1);
    }
    throw err;
  }
}

// Allow operator-initiated reap by calling this script with --reap.
if (process.argv.includes("--reap")) {
  await reapGateway(connectionId);
  console.log(`Reaped gateway for connection ${connectionId}`);
  process.exit(0);
}

await main();
