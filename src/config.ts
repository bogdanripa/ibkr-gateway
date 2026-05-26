// Centralised runtime config. Reads from env once at startup.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  projectId: required("GCP_PROJECT_ID"),
  port: Number(process.env.PORT ?? 8080),
  // Public origin (no trailing slash). Used to construct absolute URLs
  // in OAuth metadata responses + redirect URIs. Falls back to the
  // production deploy for convenience in local-dev when not set.
  publicOrigin: (process.env.PUBLIC_ORIGIN ?? "https://ibkr-gateway.bogdanripa.com").replace(/\/$/, ""),
} as const;
