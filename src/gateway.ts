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
import { TwoFactorRequiredError, CredentialRejectedError } from "./errors.js";

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

  // Fetch credential, use it, drop it.
  let cred: IbkrCredential | null = await fetchCredential(connectionId);
  try {
    await dockerRunIBeam({ containerName, hostPort, cred });
  } finally {
    cred = null; // hint to GC; the docker arg buffers are scoped to dockerRunIBeam.
  }

  const handle: GatewayHandle = {
    connectionId,
    containerName,
    hostPort,
    baseUrl: `https://127.0.0.1:${hostPort}`,
  };

  // Wait for authenticated == true, or surface a friendly error.
  await waitForAuthenticated(handle);

  return handle;
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
  // `docker run -d` returns the container id. We expose IBeam's port 5000
  // ONLY on 127.0.0.1 — never on the public interface.
  await runDocker([
    "run",
    "-d",
    "--rm",
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
      await reapGateway(handle.connectionId);
      throw new CredentialRejectedError();
    }

    await sleep(config.spawnProbeIntervalMs);
  }

  // Timed out without authenticated. By far the most common cause is 2FA
  // on the IBKR username (§9.1). Reap the container and surface the
  // friendly remediation.
  await reapGateway(handle.connectionId);
  throw new TwoFactorRequiredError();
}

function looksRejected(s: AuthStatus): boolean {
  // IBeam surfaces auth failure via `fail` or via `connected: false +
  // authenticated: false` with a specific message. Be conservative: only
  // claim rejection on a clear signal, to avoid swallowing 2FA timeouts.
  if (s.fail && /password|invalid|reject/i.test(s.fail)) return true;
  if (s.message && /invalid (user|password|credential)/i.test(s.message)) return true;
  return false;
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
