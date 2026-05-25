// Single-Gateway launcher.
//
// Wraps the IBeam container (https://github.com/Voyz/ibeam) — a Python+Chrome
// headless wrapper around IBKR's Client Portal Gateway. One container per
// connection, bound to a unique localhost port.
//
// This module is the building block used by the Supervisor in §11 step 4.
// In step 3 (current), `scripts/test-gateway.ts` calls it directly to
// de-risk the end-to-end path against a paper account.

import { spawn } from "node:child_process";
import { config } from "./config.js";
import { fetchCredential, type IbkrCredential } from "./secrets.js";
import {
  TwoFactorRequiredError,
  CredentialRejectedError,
  SpawnTimeoutError,
} from "./errors.js";

const CONTAINER_PREFIX = "ibkr-conn-";

export interface GatewayHandle {
  connectionId: string;
  containerName: string;
  hostPort: number;
  /** Base URL of the local Gateway (https, self-signed by CP Gateway). */
  baseUrl: string;
}

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

/**
 * Start an IBeam container for a connection. Credentials are fetched from
 * Secret Manager, injected as env vars to the container, and then dropped
 * from this process's memory (§6.1).
 *
 * Throws TwoFactorRequiredError if login does not authenticate within
 * SPAWN_LOGIN_TIMEOUT_MS. Throws CredentialRejectedError if IBeam reports
 * an explicit auth failure.
 */
export async function spawnGateway(
  connectionId: string,
  hostPort: number
): Promise<GatewayHandle> {
  const containerName = CONTAINER_PREFIX + connectionId;

  // Best-effort: reap any stale container with the same name.
  await dockerRm(containerName).catch(() => undefined);

  // Fetch credential. We hold the *password* until after waitForAuthenticated
  // returns or throws, so we can strip it from container logs when we
  // attach them to error responses.
  let cred: IbkrCredential | null = await fetchCredential(connectionId);
  const password = cred.password;
  try {
    await dockerRunIBeam({ containerName, hostPort, cred });
  } finally {
    cred = null; // GC the username/password copy; we keep `password` locally.
  }

  const handle: GatewayHandle = {
    connectionId,
    containerName,
    hostPort,
    baseUrl: `https://127.0.0.1:${hostPort}`,
  };

  try {
    await waitForAuthenticated(handle);
    return handle;
  } catch (err) {
    // Attach a redacted log tail for the operator. The container is still
    // running at this point — capture before reapGateway kills it.
    if (err instanceof TwoFactorRequiredError ||
        err instanceof CredentialRejectedError ||
        err instanceof SpawnTimeoutError) {
      const logs = await captureContainerLogs(containerName, password).catch(() => "");
      err.logs = logs;
    }
    throw err;
  }
}

/** SIGKILL the container if running, then remove it. */
export async function reapGateway(connectionId: string): Promise<void> {
  const name = CONTAINER_PREFIX + connectionId;
  await dockerRm(name).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Docker helpers
// ---------------------------------------------------------------------------

interface RunArgs {
  containerName: string;
  hostPort: number;
  cred: IbkrCredential;
}

async function dockerRunIBeam(args: RunArgs): Promise<void> {
  // No --rm: we want the container around after stop so we can fetch its
  // logs for diagnostics. reapGateway() removes it explicitly.
  await runDocker([
    "run",
    "-d",
    "--name", args.containerName,
    "--restart=no",
    "-p", `127.0.0.1:${args.hostPort}:5000`,
    "-e", `IBEAM_ACCOUNT=${args.cred.username}`,
    "-e", `IBEAM_PASSWORD=${args.cred.password}`,
    config.ibeamImage,
  ]);
}

async function dockerRm(name: string): Promise<void> {
  await runDocker(["rm", "-f", name]);
}

/** Last ~120 lines of container stdout/stderr, with the IBKR password
 *  redacted. Best-effort — returns "" on any docker error. */
async function captureContainerLogs(name: string, password: string): Promise<string> {
  let logs: string;
  try {
    logs = await runDocker(["logs", "--tail", "120", name]);
  } catch {
    return "";
  }
  // Redact the password if it ever appears verbatim. IBeam shouldn't log
  // it, but belt-and-braces.
  if (password) {
    const escaped = password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    logs = logs.replace(new RegExp(escaped, "g"), "<redacted-password>");
  }
  return logs;
}

function runDocker(args: string[]): Promise<string> {
  // sudo because the VM uses the default daemon socket (root-owned). For
  // local dev, drop the sudo by adding the user to the `docker` group.
  const cmd = process.env.DOCKER_SUDO === "0" ? "docker" : "sudo";
  const argv = process.env.DOCKER_SUDO === "0" ? args : ["docker", ...args];

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.stderr.on("data", (d) => { err += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`docker ${args[0]} failed (${code}): ${err.trim()}`));
    });
    proc.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Auth-status polling
// ---------------------------------------------------------------------------

interface AuthStatus {
  authenticated: boolean;
  competing: boolean;
  connected: boolean;
  message?: string;
  fail?: string;
}

async function probeAuthStatus(handle: GatewayHandle): Promise<AuthStatus | null> {
  // CP Gateway uses a self-signed cert. We must disable cert validation for
  // this localhost call. (Not a security issue: it's a loopback connection
  // to a process we just spawned ourselves.)
  const url = `${handle.baseUrl}/v1/api/iserver/auth/status`;
  try {
    const resp = await fetchInsecure(url);
    if (resp.status === 401 || resp.status === 403) return null;
    if (!resp.ok) return null;
    const body = await resp.json();
    return body as AuthStatus;
  } catch {
    // Container not up yet, port not listening, etc.
    return null;
  }
}

async function waitForAuthenticated(handle: GatewayHandle): Promise<void> {
  const start = Date.now();
  let lastStatus: AuthStatus | null = null;

  while (Date.now() - start < config.spawnLoginTimeoutMs) {
    lastStatus = await probeAuthStatus(handle);
    if (lastStatus?.authenticated === true) return;

    // Explicit IBeam-reported login failure → credential rejected.
    if (lastStatus && looksRejected(lastStatus)) {
      throw new CredentialRejectedError();
    }

    await sleep(config.spawnProbeIntervalMs);
  }

  // Timed out. Don't blindly call it 2FA — only do so if the IBeam
  // container actually logged a 2FA prompt. Otherwise it's a generic
  // SpawnTimeout (slow boot, network, etc.) and the operator gets the
  // log tail to diagnose.
  const logs = await runDocker(["logs", "--tail", "200", handle.containerName]).catch(() => "");
  if (looksLikeTwoFactor(logs)) throw new TwoFactorRequiredError();
  if (looksLikeCredRejectInLogs(logs)) throw new CredentialRejectedError();
  throw new SpawnTimeoutError();
}

function looksRejected(s: AuthStatus): boolean {
  if (s.fail && /password|invalid|reject/i.test(s.fail)) return true;
  if (s.message && /invalid (user|password|credential)/i.test(s.message)) return true;
  return false;
}

function looksLikeTwoFactor(logs: string): boolean {
  // IBeam's log line when 2FA is required:
  //   "Two-Factor Authentication request received..."
  //   or "waiting for 2FA"
  //   or "select the device" / IBKR Mobile push prompt
  return /two[-\s]?factor|2fa|select the device|notif(?:ication)? from IBKR Mobile/i.test(logs);
}

function looksLikeCredRejectInLogs(logs: string): boolean {
  return /invalid (?:user|password|credential)|password.*incorrect|account.*locked/i.test(logs);
}

// ---------------------------------------------------------------------------
// Minimal insecure-localhost fetcher
// ---------------------------------------------------------------------------

async function fetchInsecure(url: string): Promise<Response> {
  // Node 20+ has global fetch. To accept self-signed certs on localhost we
  // use an Undici Agent with rejectUnauthorized: false.
  const { Agent } = await import("undici");
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  // @ts-expect-error – Node's fetch accepts `dispatcher` via undici typings.
  return fetch(url, { dispatcher });
}

/**
 * Fetch the list of IBKR account ids associated with this session.
 * Used after a successful spawn to capture the user's IBKR account id
 * onto the Firestore document.
 *
 * Returns null on any failure — the caller treats account id as optional.
 */
export async function fetchPortfolioAccountIds(
  handle: GatewayHandle
): Promise<string[] | null> {
  try {
    const resp = await fetchInsecure(`${handle.baseUrl}/v1/api/portfolio/accounts`);
    if (!resp.ok) return null;
    const body = (await resp.json()) as Array<{ id?: string; accountId?: string }>;
    if (!Array.isArray(body)) return null;
    const ids = body
      .map((a) => a.id ?? a.accountId)
      .filter((x): x is string => typeof x === "string" && x.length > 0);
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
