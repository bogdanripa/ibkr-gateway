// Firebase Auth ID-token verification middleware.
//
// The console UI signs the user in client-side via the Firebase JS SDK
// (Google provider). It then attaches the ID token to every backend
// request as `Authorization: Bearer <id_token>`. This middleware
// verifies the token using the Firebase Admin SDK, looks up (or
// creates) the matching ibkr_accounts document, and attaches the
// signed-in user to req.consoleUser.

import type { Request, Response, NextFunction } from "express";
import admin from "firebase-admin";
import { FieldValue } from "@google-cloud/firestore";
import { config } from "../config.js";
import { accountsCol, type AccountDoc } from "../firestore.js";
import { logError } from "../logging.js";

// Initialise Firebase Admin once. On the VM (and locally via ADC) the
// project credentials are picked up automatically.
if (!admin.apps.length) {
  admin.initializeApp({ projectId: config.projectId });
}

export interface ConsoleUser {
  firebase_uid: string;
  email: string;
  display_name: string | null;
  account_id: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      consoleUser?: ConsoleUser;
    }
  }
}

/**
 * Verify the Firebase ID token on the request, upsert an ibkr_accounts
 * document for the user if needed, and attach req.consoleUser.
 */
export async function requireFirebaseAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: "missing bearer token" });
    return;
  }
  const idToken = match[1]!;

  // Step 1: verify the token. Any throw here is genuinely an auth
  // failure (expired, wrong project, malformed, revoked).
  let decoded: admin.auth.DecodedIdToken;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    const detail = (err as Error).message;
    console.warn(`[auth] token verification failed: ${detail}`);
    logError({
      source: "console-api",
      code: "FIREBASE_TOKEN_INVALID",
      error: err,
      context: { path: req.path, method: req.method },
    }).catch(() => undefined);
    res.status(401).json({ error: "invalid token", detail });
    return;
  }
  if (!decoded.email) {
    res.status(401).json({ error: "token has no email claim" });
    return;
  }

  // Step 2: upsert the user record. Failures here are infrastructure
  // problems (Firestore unavailable, permission), NOT bad tokens — so
  // don't mislead the user with "invalid token".
  try {
    const user = await upsertAccount({
      firebase_uid: decoded.uid,
      email: decoded.email,
      display_name: (decoded.name as string | undefined) ?? null,
    });
    req.consoleUser = user;
    next();
  } catch (err) {
    const detail = (err as Error).message;
    console.error(`[auth] upsertAccount failed for ${decoded.uid}: ${detail}`);
    logError({
      source: "console-api",
      code: "ACCOUNT_UPSERT_FAILED",
      error: err,
      context: { path: req.path, method: req.method, uid: decoded.uid },
    }).catch(() => undefined);
    res.status(500).json({ error: "account lookup failed", detail });
  }
}

/**
 * Look up an ibkr_accounts document by firebase_uid, or create one.
 * Idempotent — safe to call on every request.
 */
async function upsertAccount(args: {
  firebase_uid: string;
  email: string;
  display_name: string | null;
}): Promise<ConsoleUser> {
  const existing = await accountsCol
    .where("firebase_uid", "==", args.firebase_uid)
    .limit(1)
    .get();

  if (!existing.empty) {
    const doc = existing.docs[0]!;
    return {
      firebase_uid: args.firebase_uid,
      email: args.email,
      display_name: args.display_name,
      account_id: doc.id,
    };
  }

  const ref = await accountsCol.add({
    firebase_uid: args.firebase_uid,
    email: args.email,
    display_name: args.display_name,
    created_at: FieldValue.serverTimestamp() as unknown as AccountDoc["created_at"],
    status: "active",
  });

  return {
    firebase_uid: args.firebase_uid,
    email: args.email,
    display_name: args.display_name,
    account_id: ref.id,
  };
}
