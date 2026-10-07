import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBundleDeployed } from "../src/mcp/deploy.ts";
import { mcpServerEnv } from "../src/mcp/registration.ts";
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
