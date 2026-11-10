import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  footprintPath,
  readFootprint,
  recordCopilotLogging,
  updateFootprint,
  type SkillTarget,
} from "../src/cleanup/footprint.ts";
import {
  bundleHash,
  describeRemovals,
  outdatedSkillTargets,
  installSkills,
  planSkillInstall,
  readBundledSkills,
  removeSkills,
  sha256,
  skillBackupPath,
  skillPath,
  skillUsers,
  type BundledSkill,
} from "../src/cleanup/skills.ts";
import { planCleanup, runCleanup } from "../src/cleanup/plan.ts";

const BUNDLE: BundledSkill[] = [
  { name: "start", content: "start v2\n" },
  { name: "handoff", content: "handoff v2\n" },
  { name: "done", content: "done v2\n" },
];
const TARGETS: SkillTarget[] = ["claude", "agents"];

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "modelog-skills-"));
}

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function install(home: string, target: SkillTarget, bundle = BUNDLE): void {
  installSkills(home, target, planSkillInstall(home, target, bundle, readFootprint(footprintPath(home))));
}

test("the shipped bundle is the three skills, each with frontmatter naming itself", () => {
  const bundled = readBundledSkills(resolve(import.meta.dirname, ".."));
  assert.deepEqual(bundled.map((s) => s.name), ["start", "handoff", "done"]);
  for (const s of bundled) assert.match(s.content, new RegExp(`^---\\nname: ${s.name}\\n`));
});

for (const target of TARGETS) {
  test(`${target}: install writes, reads back and records path and hash`, () => {
    const home = tmpHome();
    install(home, target);

    const records = readFootprint(footprintPath(home))?.skills ?? [];
    assert.equal(records.length, 3);
    for (const { name, content } of BUNDLE) {
      const path = skillPath(home, target, name);
      assert.equal(readFileSync(path, "utf8"), content);
      assert.deepEqual(records.find((r) => r.name === name), { target, name, path, sha256: sha256(content) });
    }
  });

  test(`${target}: removal handles unedited, edited, pre-existing and missing files`, () => {
    const home = tmpHome();
    const own = skillPath(home, target, "start");
    put(own, "the developer's own /start\n");
    install(home, target);

    // start: a pre-existing file, set aside. handoff: edited. done: its dir also holds a file that isn't Modelog's.
    assert.equal(readFileSync(skillBackupPath(home, target, "start"), "utf8"), "the developer's own /start\n");
    writeFileSync(skillPath(home, target, "handoff"), "edited\n");
    const doneDir = dirname(skillPath(home, target, "done"));
    writeFileSync(join(doneDir, "notes.txt"), "not Modelog's\n");
    const removals = removeSkills(home, [target]);

    const by = (name: string) => removals.find((r) => r.path === skillPath(home, target, name));
    assert.equal(by("start")?.result, "removed");
    assert.equal(by("start")?.restoredFrom, skillBackupPath(home, target, "start"));
    assert.equal(readFileSync(own, "utf8"), "the developer's own /start\n");
    assert.equal(existsSync(skillBackupPath(home, target, "start")), false);

    assert.equal(by("handoff")?.result, "removed-edited");
    assert.equal(existsSync(dirname(skillPath(home, target, "handoff"))), false, "empty skill dir removed");
    assert.match(describeRemovals(removals), /handoff\/SKILL\.md: edited since install, removed\./);

    assert.equal(existsSync(skillPath(home, target, "done")), false);
    assert.equal(readFileSync(join(doneDir, "notes.txt"), "utf8"), "not Modelog's\n", "a dir holding anything else stays");

    assert.equal(readFootprint(footprintPath(home)), null, "nothing left recorded");
    assert.equal(existsSync(join(home, ".modelog")), false);
  });

  test(`${target}: a file deleted by hand reads as already gone`, () => {
    const home = tmpHome();
    install(home, target);
    const path = skillPath(home, target, "done");
    rmSync(path);
    assert.equal(removeSkills(home, [target]).find((r) => r.path === path)?.result, "already-gone");
  });
}

test("another tool's skills in the shared root are never touched", () => {
  const home = tmpHome();
  const other = join(home, ".agents", "skills", "someone-else", "SKILL.md");
  put(other, "theirs\n");
  install(home, "agents");
  removeSkills(home, ["agents"]);
  assert.equal(readFileSync(other, "utf8"), "theirs\n");
});

test("removing one root leaves the other root's skills and records alone", () => {
  const home = tmpHome();
  install(home, "claude");
  install(home, "agents");
  removeSkills(home, ["agents"]);
  assert.equal(existsSync(skillPath(home, "claude", "start")), true);
  assert.deepEqual(
    readFootprint(footprintPath(home))?.skills?.map((r) => r.target),
    ["claude", "claude", "claude"],
  );
});

test("install plans each case: new, unchanged, update, edited, someone else's", () => {
  const home = tmpHome();
  const v1 = BUNDLE.map((s) => ({ ...s, content: s.content.replace("v2", "v1") }));
  install(home, "claude", v1);
  writeFileSync(skillPath(home, "claude", "handoff"), "edited\n");
  writeFileSync(skillPath(home, "claude", "done"), "done v2\n");

  const plan = planSkillInstall(home, "claude", BUNDLE, readFootprint(footprintPath(home)));
  assert.deepEqual(plan.map((s) => s.action), ["update", "replace-edited", "unchanged"]);

  const fresh = tmpHome();
  put(skillPath(fresh, "agents", "start"), "theirs\n");
  assert.deepEqual(
    planSkillInstall(fresh, "agents", BUNDLE, null).map((s) => s.action),
    ["back-up", "create", "create"],
  );
});

test("reinstalling over a set-aside file keeps its backup on record", () => {
  const home = tmpHome();
  put(skillPath(home, "claude", "start"), "theirs\n");
  install(home, "claude");
  install(home, "claude", BUNDLE.map((s) => ({ ...s, content: s.content + "more\n" })));

  removeSkills(home, ["claude"]);
  assert.equal(readFileSync(skillPath(home, "claude", "start"), "utf8"), "theirs\n");
});

test("a backup path already taken blocks the whole bundle, and nothing is written", () => {
  const home = tmpHome();
  put(skillPath(home, "claude", "start"), "theirs\n");
  put(skillBackupPath(home, "claude", "start"), "an older backup\n");

  const plan = planSkillInstall(home, "claude", BUNDLE, null);
  assert.equal(plan[0].action, "blocked");
  assert.throws(() => installSkills(home, "claude", plan), /Nothing was installed/);
  assert.equal(existsSync(skillPath(home, "claude", "handoff")), false);
  assert.equal(readFileSync(skillPath(home, "claude", "start"), "utf8"), "theirs\n");
  assert.equal(readFileSync(skillBackupPath(home, "claude", "start"), "utf8"), "an older backup\n");
});

// --- who still uses a root ---------------------------------------------------

test("the Claude root is in use while any project still carries a modelog entry", () => {
  const home = tmpHome();
  put(
    join(home, ".claude.json"),
    JSON.stringify({
      projects: { "/a": { mcpServers: { modelog: {} } }, "/b": { mcpServers: { modelog: {} } }, "/c": {} },
    }),
  );
  assert.deepEqual(skillUsers(home, "claude"), ["Claude Code in /a", "Claude Code in /b"]);
  assert.deepEqual(skillUsers(home, "claude", { claudeProject: "/a" }), ["Claude Code in /b"]);
});

test("the agents root is in use by Codex, the Copilot CLI or Copilot Chat's flag", () => {
  const home = tmpHome();
  assert.deepEqual(skillUsers(home, "agents"), []);

  put(join(home, ".codex", "config.toml"), "[mcp_servers.modelog]\ncommand = \"node\"\n");
  updateFootprint(footprintPath(home), (c) => ({ ...c, copilotChatSkills: true }));
  assert.deepEqual(skillUsers(home, "agents"), ["Codex", "GitHub Copilot Chat"]);
  assert.deepEqual(skillUsers(home, "agents", { client: "codex" }), ["GitHub Copilot Chat"]);
  assert.deepEqual(skillUsers(home, "agents", { client: "copilot-chat" }), ["Codex"]);
});

// --- footprint and cleanup ----------------------------------------------------

test("clearing Copilot logging keeps the skill records (PLAN U2's fix)", () => {
  const home = tmpHome();
  const path = footprintPath(home);
  recordCopilotLogging(path, { key: "k", settingsFile: null });
  install(home, "claude");
  recordCopilotLogging(path, undefined);

  const footprint = readFootprint(path);
  assert.equal(footprint?.copilotLogging, undefined);
  assert.equal(footprint?.skills?.length, 3);
});

test("cleanup removes the skills in both roots, is recommended, and clears Copilot Chat's flag", () => {
  const home = tmpHome();
  install(home, "claude");
  install(home, "agents");
  updateFootprint(footprintPath(home), (c) => ({ ...c, copilotChatSkills: true }));
  writeFileSync(skillPath(home, "agents", "done"), "edited\n");

  const item = planCleanup({ home, platform: "linux", env: {} }).find((i) => i.id === "skills");
  assert.ok(item);
  assert.equal(item.recommended, true, "the silent hook runs it");

  const [{ outcome }] = runCleanup([item]);
  assert.equal(outcome.status, "done");
  assert.match(outcome.note, /done\/SKILL\.md: edited since install, removed/);
  for (const target of TARGETS) assert.equal(existsSync(skillPath(home, target, "start")), false);
  assert.equal(readFootprint(footprintPath(home)), null);
});

test("cleanup offers nothing for skills on a machine they were never installed on", () => {
  const items = planCleanup({ home: tmpHome(), platform: "linux", env: {} });
  assert.equal(items.find((i) => i.id === "skills"), undefined);
});

// --- a release that changes the skills ---------------------------------------

test("a root is outdated when what Modelog wrote there differs from this release's bundle", () => {
  const home = tmpHome();
  const v1 = BUNDLE.map((s) => ({ ...s, content: s.content.replace("v2", "v1") }));
  install(home, "claude", v1);
  install(home, "agents");
  assert.deepEqual(outdatedSkillTargets(BUNDLE, readFootprint(footprintPath(home))), ["claude"]);

  install(home, "claude");
  assert.deepEqual(outdatedSkillTargets(BUNDLE, readFootprint(footprintPath(home))), []);
});

test("the developer's own edit is not mistaken for an older release", () => {
  const home = tmpHome();
  install(home, "claude");
  writeFileSync(skillPath(home, "claude", "start"), "edited\n");
  assert.deepEqual(outdatedSkillTargets(BUNDLE, readFootprint(footprintPath(home))), []);
});

test("nothing installed means nothing outdated, and the bundle hash tracks content", () => {
  assert.deepEqual(outdatedSkillTargets(BUNDLE, null), []);
  assert.notEqual(bundleHash(BUNDLE), bundleHash([{ ...BUNDLE[0], content: "x" }, BUNDLE[1], BUNDLE[2]]));
});
