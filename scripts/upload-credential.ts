// One-shot helper: read IBKR username/password from stdin, write them to
// Secret Manager under the secret name pointed at by an existing
// ibkr_connection document.
//
// Usage (interactive — does NOT take password as a CLI arg, by design):
//   tsx scripts/upload-credential.ts <connectionId>
//
// The connectionId is the Firestore document id from `npm run seed` output.
// The credential is stored in GCP Secret Manager only; never printed,
// never written to disk, never logged.

import { createInterface } from "node:readline";
import { connectionsCol } from "../src/firestore.js";
import {
  createCredential,
  updateCredential,
  credentialExists,
} from "../src/secrets.js";

const connectionId = process.argv[2];
if (!connectionId) {
  console.error("Usage: tsx scripts/upload-credential.ts <connectionId>");
  process.exit(2);
}

async function main() {
  const docRef = connectionsCol.doc(connectionId);
  const doc = await docRef.get();
  if (!doc.exists) {
    console.error(`No ibkr_connections document with id ${connectionId}`);
    process.exit(2);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

  // Username can be echoed; password should not. Node readline has no
  // built-in masked input, so we toggle the terminal raw mode for the
  // password prompt.
  const username = (await ask("IBKR username: ")).trim();

  process.stdout.write("IBKR password: ");
  const password = await readPasswordSilently();
  process.stdout.write("\n");

  rl.close();

  if (!username || !password) {
    console.error("username and password are both required");
    process.exit(2);
  }

  const exists = await credentialExists(connectionId);
  if (exists) {
    await updateCredential(connectionId, { username, password, mode: "paper" });
    console.log(`Rotated credential for connection ${connectionId}`);
  } else {
    const ref = await createCredential(connectionId, { username, password, mode: "paper" });
    // If the Firestore doc's stored ref differs from the actual created ref,
    // update the doc so they agree.
    if (doc.get("ibkr_credential_ref") !== ref) {
      await docRef.update({ ibkr_credential_ref: ref });
      console.log(`Updated ibkr_credential_ref to ${ref}`);
    }
    console.log(`Stored credential for connection ${connectionId}`);
  }

  // Drop references explicitly. (Strings are immutable in JS, so we cannot
  // zero memory — but losing the only reference lets the GC reclaim it.)
}

function readPasswordSilently(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setEncoding("utf8");
    const wasRaw = stdin.isRaw ?? false;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    let buf = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.off("data", onData);
          if (stdin.isTTY) stdin.setRawMode(wasRaw);
          stdin.pause();
          resolve(buf);
          return;
        }
        if (ch === "") { // Ctrl-C
          if (stdin.isTTY) stdin.setRawMode(wasRaw);
          process.exit(130);
        }
        if (ch === "" || ch === "\b") {
          buf = buf.slice(0, -1);
        } else {
          buf += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

main().catch((err) => {
  // Do NOT print err.cause or similar — Secret Manager errors can include
  // request bodies in some failure modes. Surface only the message.
  console.error("upload-credential failed:", (err as Error).message);
  process.exit(1);
});
