// Tear down an IBeam container for a connection.
//
// Usage: tsx scripts/reap-gateway.ts <connectionId>

import { reapGateway } from "../src/gateway.js";

const connectionId = process.argv[2];
if (!connectionId) {
  console.error("Usage: tsx scripts/reap-gateway.ts <connectionId>");
  process.exit(2);
}

await reapGateway(connectionId);
console.log(`Reaped gateway for connection ${connectionId}`);
