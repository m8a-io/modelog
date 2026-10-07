import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Copies the MCP server bundle into a version-independent directory
 * (`globalStorageUri`, in practice) so registered client config can reference
 * a path that survives extension updates (MCP.md §7.1).
 *
 * Hash-compared rather than always written, so an unchanged bundle is not
 * rewritten — and so the returned hash can double as a cheap version string
 * for {@link https://code.visualstudio.com/api/extension-guides/ai/mcp | McpStdioServerDefinition.version},
 * which VS Code uses to detect that it should refresh a server's tools.
 */
export function ensureBundleDeployed(
  sourcePath: string,
  targetDir: string,
): { path: string; hash: string } {
  const content = readFileSync(sourcePath);
  const hash = createHash("sha256").update(content).digest("hex");
  const target = join(targetDir, "mcp-server.mjs");

  const current = existsSync(target) ? readFileSync(target) : null;
  if (current === null || !content.equals(current)) {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(target, content);
  }

  return { path: target, hash };
}
