// Centralised runtime config. Reads from env once at startup.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  projectId: required("GCP_PROJECT_ID"),
  port: Number(process.env.PORT ?? 8080),

  // ---- Gateway / IBeam (§7) ----
  ibeamImage: process.env.IBEAM_IMAGE ?? "voyz/ibeam:latest",
  /** Host port range allocated to Gateway containers. */
  gatewayPortMin: Number(process.env.GATEWAY_PORT_MIN ?? 5001),
  gatewayPortMax: Number(process.env.GATEWAY_PORT_MAX ?? 5100),
  /** Total time we wait for a fresh container to reach authenticated == true.
   * IBeam first-boot includes a headless Chromium login dance — be generous. */
  spawnLoginTimeoutMs: Number(process.env.SPAWN_LOGIN_TIMEOUT_MS ?? 120_000),
  /** Interval between auth-status probes during a spawn wait. */
  spawnProbeIntervalMs: Number(process.env.SPAWN_PROBE_INTERVAL_MS ?? 2_000),
  /** Keep-alive tickle interval (§7.2). */
  keepaliveIntervalMs: Number(process.env.KEEPALIVE_INTERVAL_MS ?? 30_000),
} as const;
