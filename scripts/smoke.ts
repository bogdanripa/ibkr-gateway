// Local smoke test. Exercises the Firestore queries and Secret Manager
// access that the production API depends on, BEFORE pushing.
//
// Catches things like:
//   - missing composite indexes (the query fails with a clear error
//     plus a URL to create the index)
//   - service-account permission gaps
//   - Firestore/Secret Manager SDK init issues
//
// Does NOT test the HTTP surface — see scripts/smoke-http.sh for that.
//
// Run: GCP_PROJECT_ID=auto-trader-493814 npm run smoke

import { randomUUID } from "node:crypto";
import { FieldValue } from "@google-cloud/firestore";
import {
  accountsCol,
  connectionsCol,
  apiKeysCol,
  type AccountDoc,
  type ConnectionDoc,
  type ApiKeyDoc,
} from "../src/firestore.js";
import {
  createCredential,
  destroyCredential,
  credentialExists,
} from "../src/secrets.js";

const TAG = `smoke-${randomUUID().slice(0, 8)}`;
let exitCode = 0;

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  process.stdout.write(`  ${name.padEnd(44, " ")}`);
  try {
    const v = await fn();
    process.stdout.write("OK\n");
    return v;
  } catch (err) {
    process.stdout.write("FAIL\n");
    const e = err as { message?: string; code?: number; details?: string };
    console.error(`    ${e.message ?? err}`);
    if (e.details) console.error(`    detail: ${e.details}`);
    exitCode = 1;
    return undefined;
  }
}

async function main() {
  console.log(`Smoke test (tag=${TAG})\n`);

  // 1. Account write/read.
  const accountId = await step("create account doc", async () => {
    const ref = await accountsCol.add({
      firebase_uid: `${TAG}-uid`,
      email: `${TAG}@example.com`,
      display_name: TAG,
      created_at: FieldValue.serverTimestamp() as unknown as AccountDoc["created_at"],
      status: "active",
    });
    return ref.id;
  });

  // 2. The query that backs GET /console/api/me — single-field lookup.
  await step("lookup account by firebase_uid (single)", async () => {
    const snap = await accountsCol
      .where("firebase_uid", "==", `${TAG}-uid`)
      .limit(1)
      .get();
    if (snap.empty) throw new Error("not found");
  });

  if (!accountId) return; // nothing else to do if the account didn't write

  // 3. Connection write.
  const connectionId = await step("create connection doc", async () => {
    const ref = await connectionsCol.add({
      account_id: accountId,
      ibkr_account_id: null,
      label: TAG,
      created_at: FieldValue.serverTimestamp() as unknown as ConnectionDoc["created_at"],
      ibkr_credential_ref: "smoke-ref",
      credential_status: "unknown",
      credential_checked_at: null,
    });
    return ref.id;
  });

  // 4. The query that backs GET /console/api/connections — composite index.
  //    This is the one that crashed in production.
  await step("list connections (composite index)", async () => {
    await connectionsCol
      .where("account_id", "==", accountId)
      .orderBy("created_at", "desc")
      .get();
  });

  if (connectionId) {
    // 5. API key write.
    const apiKeyId = await step("create api key doc", async () => {
      const ref = await apiKeysCol.add({
        ibkr_connection_id: connectionId,
        key_hash: "fake-hash",
        key_prefix: "smoke" + TAG.slice(-3),
        label: TAG,
        created_at: FieldValue.serverTimestamp() as unknown as ApiKeyDoc["created_at"],
        last_used_at: null,
        revoked_at: null,
      });
      return ref.id;
    });

    // 6. The query that backs GET /console/api/connections/:id/api-keys.
    await step("list api keys (composite index)", async () => {
      await apiKeysCol
        .where("ibkr_connection_id", "==", connectionId)
        .orderBy("created_at", "desc")
        .get();
    });

    // 7. Secret Manager round-trip (smoke-only — does not store a real cred).
    await step("secret manager create + delete", async () => {
      const sentinel = { username: TAG, password: `pw-${randomUUID()}` };
      await createCredential(connectionId, sentinel);
      const exists = await credentialExists(connectionId);
      if (!exists) throw new Error("secret missing after create");
      await destroyCredential(connectionId);
    });

    // Cleanup
    if (apiKeyId) await apiKeysCol.doc(apiKeyId).delete().catch(() => undefined);
    await connectionsCol.doc(connectionId).delete().catch(() => undefined);
  }

  await accountsCol.doc(accountId).delete().catch(() => undefined);

  console.log(`\n${exitCode === 0 ? "All smoke checks passed." : "FAILED."}`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
