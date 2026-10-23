import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBundleDeployed } from "../src/mcp/deploy.ts";
import { mcpServerEnv } from "../src/mcp/registration.ts";
import {
  MCP_SERVER_NAME,
  backupFile,
  codexClient,
  copilotCliClient,
  formatCommand,
  isRegisteredWithCli,
  mcpAddArgs,
  mcpGetArgs,
  mcpRemoveArgs,
  runCli,
} from "../src/mcp/cliRegistration.ts";
import { dbPath } from "../src/store/index.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "modelog-mcp-deploy-"));
}

test("ensureBundleDeployed writes into a fresh target directory", () => {
  const src = tmpDir();
  const sourcePath = join(src, "mcp-server.mjs");
  writeFileSync(sourcePath, "console.log('v1')");
  const targetDir = join(tmpDir(), "nested", "globalStorage");

  const { path, hash } = ensureBundleDeployed(sourcePath, targetDir);

  assert.equal(path, join(targetDir, "mcp-server.mjs"));
  assert.equal(readFileSync(path, "utf8"), "console.log('v1')");
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test("ensureBundleDeployed does not rewrite an unchanged bundle", () => {
  const src = tmpDir();
  const sourcePath = join(src, "mcp-server.mjs");
  writeFileSync(sourcePath, "console.log('v1')");
  const targetDir = tmpDir();

  const first = ensureBundleDeployed(sourcePath, targetDir);
  const mtimeBefore = statSync(first.path).mtimeMs;

  const second = ensureBundleDeployed(sourcePath, targetDir);
  const mtimeAfter = statSync(second.path).mtimeMs;

  assert.equal(second.hash, first.hash);
  assert.equal(mtimeAfter, mtimeBefore);
});

test("ensureBundleDeployed rewrites when content differs from what's on disk", () => {
  const src = tmpDir();
  const sourcePath = join(src, "mcp-server.mjs");
  const targetDir = tmpDir();

  writeFileSync(sourcePath, "v1");
  const first = ensureBundleDeployed(sourcePath, targetDir);

  writeFileSync(sourcePath, "v2 - different content");
  const second = ensureBundleDeployed(sourcePath, targetDir);

  assert.notEqual(second.hash, first.hash);
  assert.equal(readFileSync(second.path, "utf8"), "v2 - different content");
});

test("mcpServerEnv points MODELOG_DB at the same path the store uses", () => {
  const env = mcpServerEnv("/home/user/.vscode/globalStorage/modelog.modelog");
  assert.equal(env.MODELOG_DB, dbPath("/home/user/.vscode/globalStorage/modelog.modelog"));
  assert.equal(env.MODELOG_BILLING_MODE, undefined);
});

test("mcpServerEnv forwards an explicit billing override", () => {
  assert.equal(mcpServerEnv("/x", "api").MODELOG_BILLING_MODE, "api");
  assert.equal(mcpServerEnv("/x", "subscription").MODELOG_BILLING_MODE, "subscription");
});

test("mcpServerEnv treats 'auto' as no override, same as unset", () => {
  assert.equal(mcpServerEnv("/x", "auto").MODELOG_BILLING_MODE, undefined);
});

// --- CLI-based registration (Codex, Copilot CLI) ---------------------------

test("mcpAddArgs puts every env var before the -- separator and the command after it", () => {
  const args = mcpAddArgs("/storage/mcp-server.mjs", {
    MODELOG_DB: "/storage/modelog.db",
    MODELOG_BILLING_MODE: "api",
  });

  assert.deepEqual(args, [
    "mcp",
    "add",
    "modelog",
    "--env",
    "MODELOG_DB=/storage/modelog.db",
    "--env",
    "MODELOG_BILLING_MODE=api",
    "--",
    "node",
    "/storage/mcp-server.mjs",
  ]);
});

test("mcpAddArgs omits --env entirely when there is nothing to pass", () => {
  assert.deepEqual(mcpAddArgs("/s/mcp-server.mjs", {}), [
    "mcp",
    "add",
    "modelog",
    "--",
    "node",
    "/s/mcp-server.mjs",
  ]);
});

test("remove and get target the same entry name add writes, so Disable can find it", () => {
  assert.ok(mcpAddArgs("/s/x.mjs", {}).includes(MCP_SERVER_NAME));
  assert.deepEqual(mcpRemoveArgs(), ["mcp", "remove", MCP_SERVER_NAME]);
  assert.deepEqual(mcpGetArgs(), ["mcp", "get", MCP_SERVER_NAME]);
});

test("the two clients name different executables and different config files", () => {
  const codex = codexClient("/home/dev");
  const copilot = copilotCliClient("/home/dev");

  assert.equal(codex.bin, "codex");
  assert.equal(codex.configPath, "/home/dev/.codex/config.toml");
  assert.equal(copilot.bin, "copilot");
  assert.equal(copilot.configPath, "/home/dev/.copilot/mcp-config.json");
});

/**
 * Measured against codex-cli 0.162.0 and GitHub Copilot CLI 1.0.94 on
 * 2026-10-22, and load-bearing: getting this backwards makes re-registering
 * fail on Copilot with the CLI's "already exists" error surfaced as if Modelog
 * had done something wrong.
 */
test("only Codex's mcp add replaces an existing entry", () => {
  assert.equal(codexClient("/h").addReplaces, true);
  assert.equal(copilotCliClient("/h").addReplaces, false);
});

test("formatCommand quotes only what needs it, so the line stays pasteable", () => {
  assert.equal(
    formatCommand("codex", ["mcp", "add", "modelog", "--", "node", "/plain/path.mjs"]),
    "codex mcp add modelog -- node /plain/path.mjs",
  );
  assert.equal(
    formatCommand("codex", ["--env", "MODELOG_DB=/Application Support/x.db"]),
    "codex --env 'MODELOG_DB=/Application Support/x.db'",
  );
});

test("runCli reports a missing executable as not-found, not as a failure", () => {
  const result = runCli("modelog-no-such-binary", ["mcp", "list"], { cwd: tmpdir() });
  assert.equal(result.status, "not-found");
});

test("isRegisteredWithCli answers undefined when the CLI is absent — distinct from 'no'", () => {
  const absent = { ...codexClient("/h"), bin: "modelog-no-such-binary" };
  assert.equal(isRegisteredWithCli(absent, tmpdir()), undefined);
});

test("backupFile copies an existing config and is a no-op for one that does not exist yet", () => {
  const dir = tmpDir();
  const config = join(dir, "config.toml");
  writeFileSync(config, 'model = "gpt-6-sol"\n');

  backupFile(config);
  assert.equal(readFileSync(`${config}.bak`, "utf8"), 'model = "gpt-6-sol"\n');

  const absent = join(dir, "never-written.json");
  backupFile(absent);
  assert.equal(existsSync(`${absent}.bak`), false);
});
