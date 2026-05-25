// Lifecycle + no-logging test for src/secrets.ts (§6.1).
//
// Asserts:
//   1. create / fetch / update / destroy round-trip works
//   2. The plaintext password NEVER appears in console output captured
//      across the whole lifecycle. This guards the §6.1 "no logging" rule.
//
// Run: tsx scripts/test-secrets.ts

import { randomUUID } from "node:crypto";
import {
  createCredential,
  fetchCredential,
  updateCredential,
  destroyCredential,
  credentialExists,
  type IbkrCredential,
} from "../src/secrets.js";

// A high-entropy sentinel value. If it ever appears in console output,
// the test fails.
const SECRET_SENTINEL = `pw_${randomUUID()}_${randomUUID()}`;

const cred1: IbkrCredential = {
  username: "test-user-1",
  password: SECRET_SENTINEL,
};

const cred2: IbkrCredential = {
  username: "test-user-1",
  password: `${SECRET_SENTINEL}-rotated`,
};

// Intercept all console output. Anything written here is searched for the
// sentinel at the end of the test.
const captured: string[] = [];
const realLog = console.log.bind(console);
const realErr = console.error.bind(console);
const realWarn = console.warn.bind(console);
const realInfo = console.info.bind(console);
console.log = (...args) => { captured.push(args.map(String).join(" ")); };
console.error = (...args) => { captured.push(args.map(String).join(" ")); };
console.warn = (...args) => { captured.push(args.map(String).join(" ")); };
console.info = (...args) => { captured.push(args.map(String).join(" ")); };

async function main() {
  const connId = `test-${randomUUID().slice(0, 8)}`;
  let createdOk = false;

  try {
    // Clean slate.
    if (await credentialExists(connId)) {
      await destroyCredential(connId);
    }

    // Create.
    const ref = await createCredential(connId, cred1);
    if (!ref.endsWith(`/secrets/ibkr-conn-${connId}`)) {
      throw new Error(`Unexpected ref: ${ref}`);
    }
    createdOk = true;

    // Fetch — round-trip.
    const fetched = await fetchCredential(connId);
    if (fetched.username !== cred1.username || fetched.password !== cred1.password) {
      throw new Error("Fetched credential did not match created credential");
    }

    // Update (rotation).
    await updateCredential(connId, cred2);
    const rotated = await fetchCredential(connId);
    if (rotated.password !== cred2.password) {
      throw new Error("Rotation did not take effect");
    }

    // Destroy.
    await destroyCredential(connId);
    createdOk = false;

    if (await credentialExists(connId)) {
      throw new Error("Secret still exists after destroy");
    }
  } finally {
    // Best-effort cleanup if a step threw mid-flight.
    if (createdOk) {
      try { await destroyCredential(connId); } catch { /* ignore */ }
    }

    // Restore console.
    console.log = realLog;
    console.error = realErr;
    console.warn = realWarn;
    console.info = realInfo;
  }

  // ---- The no-logging assertion. ----
  const joined = captured.join("\n");
  if (joined.includes(SECRET_SENTINEL)) {
    realErr(`FAIL: credential sentinel appeared in console output`);
    realErr(`captured length: ${joined.length} chars`);
    process.exit(1);
  }

  realLog("OK: secrets lifecycle passes; no credential leaked to console.");
  realLog(`  (intercepted ${captured.length} log line(s); none contained the sentinel)`);
}

main().catch((err) => {
  // Restore so the error itself prints.
  console.log = realLog;
  console.error = realErr;
  console.warn = realWarn;
  console.info = realInfo;
  console.error("test-secrets failed:", err);
  process.exit(1);
});
