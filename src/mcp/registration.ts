import { dbPath } from "../store/index.ts";

/**
 * Environment passed to a spawned `mcp-server.mjs` process, shared by both
 * registration targets (Target A: the VS Code provider API; Target B: the
 * Claude Code config writer) so the two cannot disagree on how the server
 * finds its store or its billing override.
 *
 * `billingMode` is omitted (not just falsy) unless the user explicitly chose
 * "api" or "subscription" — `server.ts#resolveBilling` treats an unset
 * `MODELOG_BILLING_MODE` as "detect", and "auto" is that same choice made
 * explicitly, so it must not be forwarded as if it were an override.
 */
export function mcpServerEnv(
  storageDir: string,
  billingMode?: string,
): Record<string, string> {
  const env: Record<string, string> = { MODELOG_DB: dbPath(storageDir) };
  if (billingMode === "api" || billingMode === "subscription") {
    env.MODELOG_BILLING_MODE = billingMode;
  }
  return env;
}
