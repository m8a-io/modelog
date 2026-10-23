import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  footprintPath,
  readFootprint,
  recordCopilotLogging,
  removeFootprint,
  writeFootprint,
} from "../src/cleanup/footprint.ts";
import {
  findSettingsFileWith,
  isSettingEnabled,
  listProfiles,
  settingsCandidates,
  withSettingDisabled,
  COPILOT_LOGGING_SETTING,
} from "../src/cleanup/settings.ts";
import { withoutModelogServerEverywhere } from "../src/mcp/claudeConfig.ts";
import { planCleanup, runCleanup } from "../src/cleanup/plan.ts";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "modelog-cleanup-"));
}

// --- footprint -------------------------------------------------------------

test("a missing footprint reads as nothing recorded, not as an error", () => {
  assert.equal(readFootprint(footprintPath(tmpHome())), null);
});

test("an unreadable or future-version footprint is ignored rather than trusted", () => {
  const home = tmpHome();
  const path = footprintPath(home);
  mkdirSync(join(path, ".."), { recursive: true });

  writeFileSync(path, "{ not json");
  assert.equal(readFootprint(path), null);

  writeFileSync(path, JSON.stringify({ version: 99 }));
  assert.equal(readFootprint(path), null);
});

test("recording keeps the settings file so the hook undoes exactly what was done", () => {
  const path = footprintPath(tmpHome());
  recordCopilotLogging(path, { key: COPILOT_LOGGING_SETTING, settingsFile: "/u/settings.json" });

  assert.deepEqual(readFootprint(path)?.copilotLogging, {
    key: COPILOT_LOGGING_SETTING,
    settingsFile: "/u/settings.json",
  });
});

/**
 * The record means "Modelog is the reason this is on". Once the user has
 * turned it off again that is no longer true, and a stale record would make a
 * later cleanup switch off a setting they had since re-enabled themselves.
 */
test("clearing the record removes the file entirely, leaving nothing behind", () => {
  const home = tmpHome();
  const path = footprintPath(home);
  recordCopilotLogging(path, { key: "k", settingsFile: null });
  assert.equal(existsSync(path), true);

  recordCopilotLogging(path, undefined);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(join(home, ".modelog")), false);
});

test("removeFootprint leaves a directory that holds anything else alone", () => {
  const home = tmpHome();
  const path = footprintPath(home);
  writeFootprint(path, { version: 1 });
  writeFileSync(join(home, ".modelog", "something-else"), "x");

  removeFootprint(path);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(join(home, ".modelog", "something-else")), true);
});

// --- settings --------------------------------------------------------------

test("settings candidates cover the User dir, its profiles, remote machine settings and the platform default", () => {
  const paths = settingsCandidates({
    home: "/home/dev",
    userDir: "/home/dev/.vscode-server/data/User",
    platform: "linux",
    env: {},
    profiles: ["abc123"],
  });

  assert.ok(paths.includes("/home/dev/.vscode-server/data/User/settings.json"));
  assert.ok(paths.includes("/home/dev/.vscode-server/data/User/profiles/abc123/settings.json"));
  assert.ok(paths.includes("/home/dev/.vscode-server/data/Machine/settings.json"));
  assert.ok(paths.includes("/home/dev/.config/Code/User/settings.json"));
  assert.equal(new Set(paths).size, paths.length, "no duplicates");
});

test("candidates follow the platform, not the host this test runs on", () => {
  const mac = settingsCandidates({ home: "/Users/dev", platform: "darwin", env: {} });
  assert.ok(mac.some((p) => p.includes("Library/Application Support/Code/User")));

  const win = settingsCandidates({
    home: "C:\\Users\\dev",
    platform: "win32",
    env: { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
  });
  assert.ok(win.some((p) => p.includes("AppData")));
});

/**
 * settings.json is JSONC — comments and trailing commas are legal and common
 * — so the edit is textual. A parse-and-reserialise would throw on this very
 * fixture, and would strip the user's comment even where it worked.
 */
test("the setting is switched off without disturbing comments or any other key", () => {
  const text = `{
  // my settings
  "editor.fontSize": 14,
  "${COPILOT_LOGGING_SETTING}": true,
  "workbench.colorTheme": "Default Dark+",
}`;

  const next = withSettingDisabled(text, COPILOT_LOGGING_SETTING);
  assert.ok(next);
  assert.equal(next, text.replace(`"${COPILOT_LOGGING_SETTING}": true`, `"${COPILOT_LOGGING_SETTING}": false`));
  assert.ok(next.includes("// my settings"));
  assert.ok(next.includes('"editor.fontSize": 14'));
});

test("an ambiguous or already-off file is left untouched rather than edited by guess", () => {
  const twice = `{"${COPILOT_LOGGING_SETTING}": true, "x": 1, "${COPILOT_LOGGING_SETTING}": true}`;
  assert.equal(withSettingDisabled(twice, COPILOT_LOGGING_SETTING), null);

  const off = `{"${COPILOT_LOGGING_SETTING}": false}`;
  assert.equal(withSettingDisabled(off, COPILOT_LOGGING_SETTING), null);
  assert.equal(isSettingEnabled(off, COPILOT_LOGGING_SETTING), false);
});

test("the key's dots are escaped, so a near-miss key is not mistaken for it", () => {
  const other = `{"githubXcopilotXchatXagentDebugLogXfileLoggingXenabled": true}`;
  assert.equal(isSettingEnabled(other, COPILOT_LOGGING_SETTING), false);
});

test("the settings file is found by reading it, so a wrong candidate cannot cause a wrong edit", () => {
  const home = tmpHome();
  const decoy = join(home, "decoy.json");
  const real = join(home, "real.json");
  writeFileSync(decoy, `{"editor.fontSize": 14}`);
  writeFileSync(real, `{"${COPILOT_LOGGING_SETTING}": true}`);

  assert.equal(
    findSettingsFileWith([join(home, "absent.json"), decoy, real], COPILOT_LOGGING_SETTING),
    real,
  );
  assert.equal(findSettingsFileWith([decoy], COPILOT_LOGGING_SETTING), null);
});

test("listProfiles returns nothing when there is no profiles directory", () => {
  assert.deepEqual(listProfiles(tmpHome()), []);
});

// --- Claude Code, every project --------------------------------------------

/**
 * Enable can have been run in any number of folders over time. Cleaning only
 * the open one leaves the rest pointing at an `mcp-server.mjs` VS Code has
 * deleted, so Claude Code tries to spawn a missing file every session.
 */
test("cleanup removes the Claude Code entry from every project, not just one", () => {
  const config = {
    oauthAccount: { id: "keep-me" },
    projects: {
      "/a": { mcpServers: { modelog: { command: "node" }, other: { command: "x" } } },
      "/b": { mcpServers: { modelog: { command: "node" } } },
      "/c": { mcpServers: { other: { command: "x" } } },
    },
  };

  const { config: next, removedFrom } = withoutModelogServerEverywhere(config);

  const projects = next.projects ?? {};
  assert.deepEqual(removedFrom.sort(), ["/a", "/b"]);
  assert.deepEqual(projects["/a"].mcpServers, { other: { command: "x" } });
  assert.deepEqual(projects["/b"].mcpServers, {});
  assert.deepEqual(projects["/c"].mcpServers, { other: { command: "x" } });
  assert.deepEqual(next.oauthAccount, { id: "keep-me" });
});

test("a config with nothing to remove comes back as the same object", () => {
  const config = { projects: { "/c": { mcpServers: { other: {} } } } };
  const result = withoutModelogServerEverywhere(config);
  assert.equal(result.config, config);
  assert.deepEqual(result.removedFrom, []);
});

// --- the plan --------------------------------------------------------------

test("a machine Modelog never touched has nothing to clean up", () => {
  const home = tmpHome();
  const items = planCleanup({ home, platform: "linux", env: { PATH: "" } });
  assert.deepEqual(items, []);
});

test("Copilot logging is only offered when Modelog is on record as having enabled it", () => {
  const home = tmpHome();
  const settings = join(home, "settings.json");
  writeFileSync(settings, `{"${COPILOT_LOGGING_SETTING}": true}`);

  const ctx = { home, platform: "linux" as const, env: { PATH: "" } };
  assert.equal(planCleanup(ctx).length, 0, "the setting being on is not by itself grounds to touch it");

  recordCopilotLogging(footprintPath(home), {
    key: COPILOT_LOGGING_SETTING,
    settingsFile: settings,
  });
  const items = planCleanup(ctx);
  assert.deepEqual(items.map((i) => i.id), ["copilot-logging"]);
  assert.equal(items[0].recommended, true);
});

test("running it switches the setting off and forgets the record", () => {
  const home = tmpHome();
  const settings = join(home, "settings.json");
  writeFileSync(settings, `{\n  "editor.fontSize": 14,\n  "${COPILOT_LOGGING_SETTING}": true\n}`);
  recordCopilotLogging(footprintPath(home), { key: COPILOT_LOGGING_SETTING, settingsFile: settings });

  const results = runCleanup(planCleanup({ home, platform: "linux", env: { PATH: "" } }));

  assert.deepEqual(results.map((r) => r.outcome.status), ["done"]);
  assert.equal(readFileSync(settings, "utf8").includes(`"${COPILOT_LOGGING_SETTING}": false`), true);
  assert.equal(readFileSync(settings, "utf8").includes('"editor.fontSize": 14'), true);
  assert.equal(existsSync(footprintPath(home)), false);
});

/**
 * The failure that matters most: Copilot keeps writing prompt-bearing files
 * until the setting is off, so an unlocatable settings file has to produce an
 * instruction, not a silent pass.
 */
test("an unlocatable settings file fails loudly and names the key to change by hand", () => {
  const home = tmpHome();
  recordCopilotLogging(footprintPath(home), { key: COPILOT_LOGGING_SETTING, settingsFile: null });

  const [result] = runCleanup(planCleanup({ home, platform: "linux", env: { PATH: "" } }));

  assert.equal(result.outcome.status, "failed");
  assert.match(result.outcome.note, /by hand/);
  assert.match(result.outcome.note, new RegExp(COPILOT_LOGGING_SETTING.replaceAll(".", "\\.")));
});

test("the Claude Code entry is planned, backed up, and removed from every project", () => {
  const home = tmpHome();
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      primaryApiKey: "keep",
      projects: { "/a": { mcpServers: { modelog: {}, other: {} } }, "/b": { mcpServers: { modelog: {} } } },
    }),
  );

  const items = planCleanup({ home, platform: "linux", env: { PATH: "" } });
  assert.deepEqual(items.map((i) => i.id), ["claude-code-mcp"]);

  assert.equal(runCleanup(items)[0].outcome.status, "done");

  const after = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  assert.equal(after.primaryApiKey, "keep");
  assert.deepEqual(after.projects["/a"].mcpServers, { other: {} });
  assert.deepEqual(after.projects["/b"].mcpServers, {});
  assert.equal(existsSync(join(home, ".claude.json.bak")), true);
});

/**
 * The unattended hook runs `recommended` items only. Deleting the one copy
 * someone might fall back on, or history they never asked to lose, is not
 * something to do without being asked.
 */
test("backup files and collected data are offered but never recommended", () => {
  const home = tmpHome();
  const storageDir = join(home, "storage");
  mkdirSync(storageDir);
  writeFileSync(join(home, ".claude.json.bak"), "{}");
  writeFileSync(join(storageDir, "modelog.db"), "sqlite");

  const items = planCleanup({ home, platform: "linux", env: { PATH: "" }, storageDir });

  assert.deepEqual(items.map((i) => i.id).sort(), ["backups", "collected-data"]);
  assert.deepEqual(items.map((i) => i.recommended), [false, false]);
});

test("collected data is never offered when no storage directory is given — the hook cannot reach it", () => {
  const home = tmpHome();
  mkdirSync(join(home, "storage"));
  writeFileSync(join(home, "storage", "modelog.db"), "sqlite");

  assert.deepEqual(planCleanup({ home, platform: "linux", env: { PATH: "" } }), []);
});

test("one failing item does not stop the rest", () => {
  const items = [
    { id: "a", label: "A", detail: "", recommended: true, run: () => ({ status: "done" as const, note: "ok" }) },
    { id: "b", label: "B", detail: "", recommended: true, run: () => { throw new Error("boom"); } },
    { id: "c", label: "C", detail: "", recommended: true, run: () => ({ status: "done" as const, note: "ok" }) },
  ];

  const results = runCleanup(items);
  assert.deepEqual(results.map((r) => r.outcome.status), ["done", "failed", "done"]);
  assert.equal(results[1].outcome.note, "boom");
});
