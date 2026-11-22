import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  withModelogServer,
  withoutModelogServer,
  hasModelogServer,
  projectsWithModelogServer,
  type ClaudeConfig,
  type McpServerEntry,
} from "../src/mcp/claudeConfig.ts";
import { readClaudeConfig, backupAndWriteClaudeConfig } from "../src/mcp/claudeConfigFile.ts";
import { isNodeOnPath, checkNode, classifyNodeVersion, nodeProblemMessage } from "../src/mcp/nodeOnPath.ts";

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

test("withModelogServer writes at user scope and touches nothing else", () => {
  const before = configWithRealWorldShape();
  const { config: after, migratedFrom } = withModelogServer(before, ENTRY);

  assert.deepEqual(after.mcpServers, { modelog: ENTRY });
  assert.deepEqual(migratedFrom, []);
  // Projects and top-level credential-bearing keys are identical.
  assert.deepEqual(after.projects, before.projects);
  assert.equal(after.oauthAccount, before.oauthAccount);
  assert.equal(after.primaryApiKey, before.primaryApiKey);
  // The original is not mutated.
  assert.equal(before.mcpServers, undefined);
});

/** Issue #39: Claude Code creates project entries lazily, so an IDE-only install can have none. */
test("withModelogServer works when the config has no projects key at all", () => {
  const before: ClaudeConfig = { oauthAccount: { id: "keep" }, userID: "u" };
  const { config: after } = withModelogServer(before, ENTRY);

  assert.deepEqual(after, { oauthAccount: { id: "keep" }, userID: "u", mcpServers: { modelog: ENTRY } });
  assert.equal("projects" in after, false, "must not invent a projects key");
});

/**
 * Issue #39: the old code registered for workspaceFolders[0], which is the
 * wrong folder in a multi-root workspace whose project is not first. At user
 * scope there is no folder to pick, so the result cannot depend on one.
 */
test("withModelogServer takes no folder, so a multi-root workspace cannot pick the wrong one", () => {
  assert.equal(withModelogServer.length, 2);
  const { config } = withModelogServer(configWithRealWorldShape(), ENTRY);
  assert.deepEqual(projectsWithModelogServer(config), []);
  assert.equal(hasModelogServer(config), true);
});

test("withModelogServer keeps sibling user-scope servers and replaces an existing modelog entry", () => {
  const before: ClaudeConfig = { mcpServers: { github: { command: "gh-mcp" }, modelog: { command: "old" } } };
  const newEntry: McpServerEntry = { command: "node", args: ["/repo/dist/v2.mjs"] };
  const { config: after } = withModelogServer(before, newEntry);

  assert.deepEqual(after.mcpServers, { github: { command: "gh-mcp" }, modelog: newEntry });
});

/** Claude Code merges {...user, ...project, ...local}: a legacy per-project entry would shadow the new one. */
test("withModelogServer removes legacy per-project entries, keeping their sibling servers", () => {
  const before = configWithRealWorldShape();
  before.projects!["/home/user/modelog"].mcpServers!.modelog = { command: "node", args: ["/stale.mjs"] };

  const { config: after, migratedFrom } = withModelogServer(before, ENTRY);

  assert.deepEqual(migratedFrom, ["/home/user/modelog"]);
  assert.deepEqual(after.projects!["/home/user/modelog"].mcpServers, { github: { command: "gh-mcp", args: [] } });
  assert.equal(after.projects!["/home/user/modelog"].hasTrustDialogAccepted, true);
  assert.deepEqual(after.projects!["/home/user/other-project"], before.projects!["/home/user/other-project"]);
});

test("withoutModelogServer removes the user-scope entry and legacy ones, keeping siblings", () => {
  const legacy = configWithRealWorldShape();
  legacy.projects!["/home/user/modelog"].mcpServers!.modelog = { command: "node" };
  const withIt: ClaudeConfig = { ...legacy, mcpServers: { modelog: ENTRY, github: { command: "gh-mcp" } } };

  const { config: after, removedUser, removedFrom } = withoutModelogServer(withIt);

  assert.equal(removedUser, true);
  assert.deepEqual(removedFrom, ["/home/user/modelog"]);
  assert.deepEqual(after.mcpServers, { github: { command: "gh-mcp" } });
  assert.deepEqual(after.projects!["/home/user/modelog"].mcpServers, { github: { command: "gh-mcp", args: [] } });
  assert.equal(after.primaryApiKey, withIt.primaryApiKey);
});

test("withoutModelogServer is a no-op, same reference, when modelog was never registered", () => {
  const config = configWithRealWorldShape();
  const result = withoutModelogServer(config);
  assert.equal(result.config, config);
  assert.equal(result.removedUser, false);
  assert.deepEqual(result.removedFrom, []);
});

test("withoutModelogServer works on a config with neither mcpServers nor projects", () => {
  const config: ClaudeConfig = { userID: "u" };
  assert.equal(withoutModelogServer(config).config, config);
});

test("hasModelogServer reports user-scope presence only", () => {
  const config = configWithRealWorldShape();
  assert.equal(hasModelogServer(config), false);
  config.projects!["/home/user/modelog"].mcpServers!.modelog = { command: "node" };
  assert.equal(hasModelogServer(config), false, "a legacy per-project entry is not a user-scope registration");
  assert.equal(hasModelogServer(withModelogServer(config, ENTRY).config), true);
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

  const updated = withModelogServer(original, ENTRY).config;
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

test("classifyNodeVersion accepts Node 24+ and refuses older or unparseable versions", () => {
  assert.deepEqual(classifyNodeVersion("v24.18.0"), { status: "ok", version: "v24.18.0" });
  assert.deepEqual(classifyNodeVersion("v25.1.0"), { status: "ok", version: "v25.1.0" });
  assert.deepEqual(classifyNodeVersion("v20.11.1"), { status: "too-old", version: "v20.11.1" });
  assert.deepEqual(classifyNodeVersion("garbage"), { status: "too-old", version: "garbage" });
});

test("checkNode reports missing when PATH cannot resolve node", () => {
  assert.deepEqual(checkNode({ PATH: "" }), { status: "missing" });
});

/** Issue #39: the extension host never sources shell rc files; the message must say so and show the PATH to fix. */
test("nodeProblemMessage explains the shell-rc trap and shows the extension host PATH", () => {
  const missing = nodeProblemMessage({ status: "missing" }, "Claude Code", "/usr/bin:/home/u/.local/bin");
  assert.match(missing, /not found/);
  assert.match(missing, /~\/\.zshrc/);
  assert.match(missing, /\/usr\/bin:\/home\/u\/\.local\/bin/);
  assert.match(missing, /Claude Code/);

  const old = nodeProblemMessage({ status: "too-old", version: "v20.1.0" }, "Codex", "/usr/bin");
  assert.match(old, /v20\.1\.0/);
  assert.match(old, /Node 24 or later/);
});
