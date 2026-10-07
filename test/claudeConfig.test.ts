import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  withModelogServer,
  withoutModelogServer,
  hasModelogServer,
  type ClaudeConfig,
  type McpServerEntry,
} from "../src/mcp/claudeConfig.ts";
import { readClaudeConfig, backupAndWriteClaudeConfig } from "../src/mcp/claudeConfigFile.ts";
import { isNodeOnPath } from "../src/mcp/nodeOnPath.ts";

const ENTRY: McpServerEntry = {
  command: "node",
  args: ["/repo/dist/mcp-server.mjs"],
  env: { MODELOG_DB: "/storage/modelog.db" },
};

function configWithRealWorldShape(): ClaudeConfig {
  // Shaped after the real ~/.claude.json on the dev machine: unrelated
  // top-level keys, including credential-bearing ones, plus two projects,
  // one of which already has an unrelated MCP server registered.
  return {
    oauthAccount: { id: "should-never-move" },
    primaryApiKey: "sk-should-never-move",
    machineID: "abc123",
    projects: {
      "/home/user/other-project": {
        mcpServers: {},
        allowedTools: ["Bash"],
      },
      "/home/user/modelog": {
        mcpServers: { github: { command: "gh-mcp", args: [] } },
        hasTrustDialogAccepted: true,
        allowedTools: [],
      },
    },
  };
}

test("withModelogServer adds the entry and touches nothing else", () => {
  const before = configWithRealWorldShape();
  const after = withModelogServer(before, "/home/user/modelog", ENTRY);

  assert.ok(after);
  assert.deepEqual(after.projects!["/home/user/modelog"].mcpServers, {
    github: { command: "gh-mcp", args: [] },
    modelog: ENTRY,
  });
  // Sibling project and top-level credential-bearing keys are identical.
  assert.deepEqual(after.projects!["/home/user/other-project"], before.projects!["/home/user/other-project"]);
  assert.equal(after.oauthAccount, before.oauthAccount);
  assert.equal(after.primaryApiKey, before.primaryApiKey);
  // The original is not mutated.
  assert.equal(before.projects!["/home/user/modelog"].mcpServers!.modelog, undefined);
});

test("withModelogServer replaces an existing modelog entry rather than duplicating it", () => {
  const before = withModelogServer(configWithRealWorldShape(), "/home/user/modelog", ENTRY)!;
  const newEntry: McpServerEntry = { command: "node", args: ["/repo/dist/v2.mjs"] };
  const after = withModelogServer(before, "/home/user/modelog", newEntry);

  assert.deepEqual(after!.projects!["/home/user/modelog"].mcpServers, {
    github: { command: "gh-mcp", args: [] },
    modelog: newEntry,
  });
});

test("withModelogServer returns null for a project Claude Code has never opened", () => {
  const config = configWithRealWorldShape();
  assert.equal(withModelogServer(config, "/home/user/never-opened", ENTRY), null);
});

test("withoutModelogServer removes only modelog, keeping sibling servers", () => {
  const withIt = withModelogServer(configWithRealWorldShape(), "/home/user/modelog", ENTRY)!;
  const after = withoutModelogServer(withIt, "/home/user/modelog");

  assert.deepEqual(after.projects!["/home/user/modelog"].mcpServers, {
    github: { command: "gh-mcp", args: [] },
  });
});

test("withoutModelogServer is a no-op, same reference, when modelog was never registered", () => {
  const config = configWithRealWorldShape();
  const after = withoutModelogServer(config, "/home/user/modelog");
  assert.equal(after, config);
});

test("withoutModelogServer on an unknown project returns the config unchanged", () => {
  const config = configWithRealWorldShape();
  const after = withoutModelogServer(config, "/home/user/never-opened");
  assert.equal(after, config);
});

test("hasModelogServer reports presence correctly", () => {
  const config = configWithRealWorldShape();
  assert.equal(hasModelogServer(config, "/home/user/modelog"), false);
  const withIt = withModelogServer(config, "/home/user/modelog", ENTRY)!;
  assert.equal(hasModelogServer(withIt, "/home/user/modelog"), true);
});

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "modelog-claude-config-"));
}

test("readClaudeConfig reports 'missing' for a nonexistent file", () => {
  const path = join(tmpDir(), ".claude.json");
  assert.deepEqual(readClaudeConfig(path), { status: "missing" });
});

test("readClaudeConfig reports 'invalid-json' without throwing", () => {
  const path = join(tmpDir(), ".claude.json");
  writeFileSync(path, "{ not json");
  assert.deepEqual(readClaudeConfig(path), { status: "invalid-json" });
});

test("readClaudeConfig parses a real file", () => {
  const path = join(tmpDir(), ".claude.json");
  const config = configWithRealWorldShape();
  writeFileSync(path, JSON.stringify(config));
  assert.deepEqual(readClaudeConfig(path), { status: "ok", config });
});

test("backupAndWriteClaudeConfig writes a .bak before overwriting the original", () => {
  const path = join(tmpDir(), ".claude.json");
  const original = configWithRealWorldShape();
  writeFileSync(path, JSON.stringify(original));

  const updated = withModelogServer(original, "/home/user/modelog", ENTRY)!;
  backupAndWriteClaudeConfig(path, updated);

  assert.equal(existsSync(`${path}.bak`), true);
  assert.deepEqual(JSON.parse(readFileSync(`${path}.bak`, "utf8")), original);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), updated);
});

test("backupAndWriteClaudeConfig overwrites a stale .bak rather than appending", () => {
  const path = join(tmpDir(), ".claude.json");
  writeFileSync(path, JSON.stringify({ projects: {}, round: 1 }));
  backupAndWriteClaudeConfig(path, { projects: {}, round: 2 });
  backupAndWriteClaudeConfig(path, { projects: {}, round: 3 });

  assert.deepEqual(JSON.parse(readFileSync(`${path}.bak`, "utf8")), { projects: {}, round: 2 });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { projects: {}, round: 3 });
});

test("isNodeOnPath is true against a PATH that actually contains node", () => {
  assert.equal(isNodeOnPath(process.env), true);
});

test("isNodeOnPath is false when PATH cannot resolve node", () => {
  assert.equal(isNodeOnPath({ PATH: "" }), false);
});
