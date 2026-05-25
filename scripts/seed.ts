// Seed one test account, one IBKR connection, one API key.
// Idempotent on firebase_uid: re-running rotates the API key but reuses
// the account/connection.
//
// Run: npm run seed

import { FieldValue } from "@google-cloud/firestore";
import {
  accountsCol,
  connectionsCol,
  apiKeysCol,
} from "../src/firestore.js";
import { generateApiKey } from "../src/apikeys.js";

const SEED_FIREBASE_UID = "seed-user-fake-uid";
const SEED_EMAIL = "seed@example.com";
const SEED_LABEL = "seed connection";

async function main() {
  // 1. Account — upsert by firebase_uid.
  const existingAccount = await accountsCol
    .where("firebase_uid", "==", SEED_FIREBASE_UID)
    .limit(1)
    .get();

  let accountId: string;
  if (existingAccount.empty) {
    const ref = await accountsCol.add({
      firebase_uid: SEED_FIREBASE_UID,
      email: SEED_EMAIL,
      display_name: "Seed User",
      created_at: FieldValue.serverTimestamp() as never,
      status: "active",
    });
    accountId = ref.id;
    console.log(`Created account ${accountId}`);
  } else {
    accountId = existingAccount.docs[0]!.id;
    console.log(`Reusing account ${accountId}`);
  }

  // 2. Connection — upsert by (account_id, label). One per seed run.
  const existingConnection = await connectionsCol
    .where("account_id", "==", accountId)
    .where("label", "==", SEED_LABEL)
    .limit(1)
    .get();

  let connectionId: string;
  if (existingConnection.empty) {
    const ref = await connectionsCol.add({
      account_id: accountId,
      ibkr_account_id: null,
      label: SEED_LABEL,
      created_at: FieldValue.serverTimestamp() as never,
      // Placeholder until §11 step 2 wires Secret Manager. The seed's
      // ref points at a not-yet-created secret name; that's fine — the
      // spawn path is the consumer and isn't built yet.
      ibkr_credential_ref: `projects/auto-trader-493814/secrets/ibkr-conn-${accountId}`,
      credential_status: "unknown",
      credential_checked_at: null,
    });
    connectionId = ref.id;
    console.log(`Created connection ${connectionId}`);
  } else {
    connectionId = existingConnection.docs[0]!.id;
    console.log(`Reusing connection ${connectionId}`);
  }

  // 3. API key — always issue a fresh one (revoke old seed keys first).
  const oldKeys = await apiKeysCol
    .where("ibkr_connection_id", "==", connectionId)
    .where("label", "==", "seed key")
    .get();
  for (const doc of oldKeys.docs) {
    if (doc.get("revoked_at") == null) {
      await doc.ref.update({ revoked_at: FieldValue.serverTimestamp() });
    }
  }

  const k = generateApiKey();
  const ref = await apiKeysCol.add({
    ibkr_connection_id: connectionId,
    key_hash: k.hash,
    key_prefix: k.prefix,
    label: "seed key",
    created_at: FieldValue.serverTimestamp() as never,
    last_used_at: null,
    revoked_at: null,
  });

  console.log(`\nSeed complete.`);
  console.log(`  account     : ${accountId}`);
  console.log(`  connection  : ${connectionId}`);
  console.log(`  api key id  : ${ref.id}`);
  console.log(`\n  RAW API KEY (shown once — copy it now):`);
  console.log(`  ${k.raw}\n`);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
