// Centralised runtime config. Reads from env once at startup.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  projectId: required("GCP_PROJECT_ID"),
  port: Number(process.env.PORT ?? 8080),
} as const;
