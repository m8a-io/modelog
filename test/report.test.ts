import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NEW_ISSUE_URL,
  buildIssueReport,
  issueUrl,
  summarizeFailure,
  type ReportEnvironment,
} from "../src/diagnostics/report.ts";

const PRIVATE_PATH = "/home/alice/.claude/projects/acme-secret-project";

function env(overrides: Partial<ReportEnvironment> = {}): ReportEnvironment {
  return {
    modelogVersion: "0.6.0",
    editorName: "Visual Studio Code",
    editorVersion: "1.140.0",
    uiKind: "desktop",
    remoteName: null,
    extensionKind: "workspace",
    platform: "win32",
    arch: "x64",
    osRelease: "10.0.26100",
    nodeVersion: "24.18.1",
    storage: "sqlite",
    activation: { state: "ready" },
    copilotChatVersion: "0.68.0",
    ...overrides,
  };
}

function privateError(): Error {
  const e = Object.assign(new Error(`EACCES: permission denied, open '${PRIVATE_PATH}'`), {
    code: "EACCES",
  });
  return e;
}

test("summarizeFailure keeps the error's name and code, never its message or stack", () => {
  const failure = summarizeFailure("Modelog: Open Dashboard", privateError());

  assert.deepEqual(failure, {
    operation: "Modelog: Open Dashboard",
    errorName: "Error",
    errorCode: "EACCES",
  });
  assert.doesNotMatch(JSON.stringify(failure), /alice|acme|permission denied/);
});

test("summarizeFailure drops a name or code that is not an identifier", () => {
  const e = Object.assign(new Error("x"), { code: `failed at ${PRIVATE_PATH}` });
  e.name = `Error at ${PRIVATE_PATH}`;

  const failure = summarizeFailure("Activation", e);

  assert.equal(failure.errorName, "Error");
  assert.equal(failure.errorCode, null);
});

test("summarizeFailure handles a thrown non-Error value without echoing it", () => {
  const failure = summarizeFailure("Activation", PRIVATE_PATH);
  assert.deepEqual(failure, { operation: "Activation", errorName: "NonErrorValue", errorCode: null });
});

test("buildIssueReport names the failure and the environment, and nothing private", () => {
  const failure = summarizeFailure("Modelog: Enable Copilot Analysis", privateError());
  const report = buildIssueReport(
    env({ remoteName: "wsl", activation: { state: "failed", failure } }),
    failure,
  );

  assert.equal(report.title, "Modelog: Enable Copilot Analysis failed (EACCES)");
  for (const expected of [
    "- Operation: Modelog: Enable Copilot Analysis",
    "- Error code: EACCES",
    "- Modelog: 0.6.0",
    "- Editor: Visual Studio Code 1.140.0 (desktop)",
    "- Extension host: remote (wsl), workspace extension",
    "- OS: win32 10.0.26100 (x64)",
    "- Extension host Node: 24.18.1",
    "- Storage: sqlite",
    "- Activation: failed (Modelog: Enable Copilot Analysis: Error, EACCES)",
    "- Copilot Chat: 0.68.0",
  ]) {
    assert.ok(report.body.includes(expected), `missing "${expected}"`);
  }
  assert.doesNotMatch(report.title + report.body, /alice|acme|permission denied/);
});

test("buildIssueReport omits the failure section for a manual report", () => {
  const report = buildIssueReport(env({ copilotChatVersion: null, storage: "not initialized" }));

  assert.equal(report.title, "Modelog problem report");
  assert.doesNotMatch(report.body, /## Failure/);
  assert.match(report.body, /- Copilot Chat: not installed/);
  assert.match(report.body, /- Storage: not initialized/);
});

test("buildIssueReport replaces environment values that do not look like versions or names", () => {
  const report = buildIssueReport(env({ osRelease: PRIVATE_PATH, editorName: "a\nb" }));

  assert.match(report.body, /- OS: win32 unknown \(x64\)/);
  assert.match(report.body, /- Editor: unknown 1\.140\.0/);
  assert.doesNotMatch(report.body, /alice/);
});

test("issueUrl round-trips the title and body through GitHub's new-issue query", () => {
  const report = { title: "A & B = C #1", body: "line 1\nfoo&body=evil+100%" };
  const url = new URL(issueUrl(report));

  assert.equal(`${url.origin}${url.pathname}`, NEW_ISSUE_URL);
  assert.equal(url.searchParams.get("title"), report.title);
  assert.equal(url.searchParams.get("body"), report.body);
  assert.equal(url.searchParams.get("labels"), "bug");
  assert.deepEqual([...url.searchParams.keys()], ["title", "body", "labels"]);
});

test("a full report stays well under browser and GitHub URL limits", () => {
  const failure = summarizeFailure("Modelog: Remove Modelog's Changes", privateError());
  const url = issueUrl(buildIssueReport(env({ activation: { state: "failed", failure } }), failure));
  assert.ok(url.length < 4000, `URL is ${url.length} characters`);
});
