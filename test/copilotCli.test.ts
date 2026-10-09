import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCopilotCliChunk, findCopilotCliLogs, copilotCliAdapter } from "../src/ingest/copilotCli.ts";
import { CAPTURE_VERSION } from "../src/ingest/capture.ts";

const DIR = join(import.meta.dirname, "fixtures", "copilot-cli");

function fixture(name: string): string {
  return readFileSync(join(DIR, name), "utf8");
}

const SINGLE_TURN = () => fixture("single-turn-session.jsonl");
const TOOL_CALL = () => fixture("tool-call-session.jsonl");

// --- small record builders, matching the real {type, data, id, timestamp, parentId} shape ---

let seq = 0;
function line(type: string, data: Record<string, unknown>, timestamp = "2026-10-09T07:28:10.000Z"): string {
  seq++;
  return JSON.stringify({ type, data, id: `id-${seq}`, timestamp, parentId: null });
}

function sessionStart(over: Record<string, unknown> = {}): string {
  return line("session.start", {
    sessionId: "sess-1",
    producer: "copilot-agent",
    context: { cwd: "/workspace/example", gitRoot: "/workspace/example", branch: "main" },
    ...over,
  });
}

function turnStart(turnId: string, interactionId: string): string {
  return line("assistant.turn_start", { turnId, interactionId });
}

function turnEnd(turnId: string): string {
  return line("assistant.turn_end", { turnId });
}

function usageRecord(
  model: string,
  over: Record<string, unknown> = {},
  timestamp = "2026-10-09T07:28:10.000Z",
): string {
  return line(
    "session.usage_record",
    {
      usage: {
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        cacheTtlSeconds: 300,
        copilotUsage: { totalNanoAiu: null },
        ...over,
      },
    },
    timestamp,
  );
}

function interaction(turnId: string, interactionId: string, usage: Record<string, unknown> = {}): string {
  return [turnStart(turnId, interactionId), usageRecord("claude-sonnet-5.5", usage), turnEnd(turnId)].join("\n");
}

// --- against the two real captured sessions ---------------------------------

test("a single-turn real session produces one turn", () => {
  const { turns, diagnostics } = parseCopilotCliChunk(SINGLE_TURN(), "events.jsonl");
  assert.equal(turns.length, 1);
  assert.equal(diagnostics.length, 0);

  const t = turns[0]!;
  assert.equal(t.model, "claude-sonnet-5.5");
  assert.equal(t.source, "copilot");
  assert.equal(t.iterations, 1);
  // usage: inputTokens 25721, cacheReadTokens 0, cacheWriteTokens 25717,
  // outputTokens 60, totalNanoAiu 6490050000 — measured from the fixture.
  assert.equal(t.inputTokens, 25721 - 0 - 25717);
  assert.equal(t.cacheReadTokens, 0);
  assert.equal(t.cacheWrite5mTokens, 25717);
  assert.equal(t.cacheWrite1hTokens, 0);
  assert.equal(t.outputTokens, 60);
  assert.equal(t.thinkingTokens, 0);
  assert.equal(t.tokenBreakdown, "reported");
  assert.equal(t.costNanoAiu, 6490050000);
  assert.equal(t.speed, null);
  assert.equal(t.inferenceGeo, null);
  assert.equal(t.entrypoint, "copilot-agent");
  assert.equal(t.isSidechain, false);
  assert.equal(t.sessionId, "e8a4dab4-dec8-475f-8075-ad4f64589673");
  assert.equal(t.cwd, "/home/scott/tmp-dev/modelog");
  assert.equal(t.gitBranch, "dev");
  assert.equal(t.captureVersion, CAPTURE_VERSION);
});

test("a tool-call session's three turn_start/turn_end round-trips aggregate into one turn", () => {
  const { turns, diagnostics } = parseCopilotCliChunk(TOOL_CALL(), "events.jsonl");
  assert.equal(turns.length, 1);
  assert.equal(diagnostics.length, 0);

  const t = turns[0]!;
  assert.equal(t.iterations, 3);
  // Three session.usage_record lines, summed — measured from the fixture:
  // plain input 4+2+2, cache read 0+23455+23586, cache write 23455+131+92,
  // output 95+55+63, cost 5959550000+322700000+322260000.
  assert.equal(t.inputTokens, 8);
  assert.equal(t.cacheReadTokens, 47041);
  assert.equal(t.cacheWrite5mTokens, 23678);
  assert.equal(t.cacheWrite1hTokens, 0);
  assert.equal(t.outputTokens, 213);
  assert.equal(t.costNanoAiu, 6604510000);
  assert.equal(t.tokenBreakdown, "reported");
});

// --- turn/iteration aggregation ----------------------------------------------

test("records sharing an interactionId across several turnIds are one turn, not one each", () => {
  const text =
    [
      sessionStart(),
      turnStart("0", "int-1"),
      usageRecord("claude-sonnet-5.5", {}, "2026-10-09T07:00:00.000Z"),
      turnEnd("0"),
      turnStart("1", "int-1"),
      usageRecord("claude-sonnet-5.5", {}, "2026-10-09T07:00:05.000Z"),
      turnEnd("1"),
    ].join("\n") + "\n";
  const { turns } = parseCopilotCliChunk(text, "f.jsonl");
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.iterations, 2);
});

test("two separate interactionIds produce two turns, ordered by timestamp", () => {
  const text =
    [
      sessionStart(),
      interaction("0", "int-1", { copilotUsage: { totalNanoAiu: 100 } }),
      interaction("1", "int-2", { copilotUsage: { totalNanoAiu: 200 } }),
    ].join("\n") + "\n";
  const { turns } = parseCopilotCliChunk(text, "f.jsonl");
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((t) => t.costNanoAiu), [100, 200]);
});

// --- token accounting ---------------------------------------------------------

test("plain input is total inputTokens minus both cache classes, not inputTokens alone", () => {
  const text =
    [
      sessionStart(),
      ...[interaction("0", "int-1", { inputTokens: 1000, cacheReadTokens: 300, cacheWriteTokens: 200 })],
    ].join("\n") + "\n";
  const { turns } = parseCopilotCliChunk(text, "f.jsonl");
  assert.equal(turns[0]!.inputTokens, 500);
  assert.equal(turns[0]!.cacheReadTokens, 300);
  assert.equal(turns[0]!.cacheWrite5mTokens, 200);
});

// --- cache TTL bucketing -------------------------------------------------------

test("a cache write reported at a 3600s TTL lands in the 1-hour bucket, not the 5-minute one", () => {
  const text = [sessionStart(), interaction("0", "int-1", { cacheWriteTokens: 400, cacheTtlSeconds: 3600 })].join("\n") + "\n";
  const { turns, diagnostics } = parseCopilotCliChunk(text, "f.jsonl");
  assert.equal(turns[0]!.cacheWrite1hTokens, 400);
  assert.equal(turns[0]!.cacheWrite5mTokens, 0);
  assert.equal(diagnostics.length, 0);
});

test("a cache write at an unrecognised TTL is priced at the 5-minute rate and flagged", () => {
  const text = [sessionStart(), interaction("0", "int-1", { cacheWriteTokens: 400, cacheTtlSeconds: 900 })].join("\n") + "\n";
  const { turns, diagnostics } = parseCopilotCliChunk(text, "f.jsonl");
  assert.equal(turns[0]!.cacheWrite5mTokens, 400);
  assert.equal(diagnostics.some((d) => d.kind === "unknown-shape" && /unrecognised cacheTtlSeconds/.test(d.detail)), true);
});

test("a zero cache write is never flagged regardless of its TTL", () => {
  const text = [sessionStart(), interaction("0", "int-1", { cacheWriteTokens: 0, cacheTtlSeconds: 900 })].join("\n") + "\n";
  const { diagnostics } = parseCopilotCliChunk(text, "f.jsonl");
  assert.equal(diagnostics.length, 0);
});

// --- session metadata ----------------------------------------------------------

test("sessionId, cwd, gitBranch and entrypoint are read from session.start", () => {
  const text =
    [
      sessionStart({ sessionId: "abc-123", context: { cwd: "/code/proj", branch: "feature-x" }, producer: "copilot-agent" }),
      interaction("0", "int-1"),
    ].join("\n") + "\n";
  const { turns } = parseCopilotCliChunk(text, "f.jsonl");
  assert.equal(turns[0]!.sessionId, "abc-123");
  assert.equal(turns[0]!.cwd, "/code/proj");
  assert.equal(turns[0]!.gitBranch, "feature-x");
  assert.equal(turns[0]!.entrypoint, "copilot-agent");
});

test("a missing session.start falls back to the parent directory name as sessionId", () => {
  const text = [interaction("0", "int-1")].join("\n") + "\n";
  const { turns } = parseCopilotCliChunk(text, "/root/session-xyz/events.jsonl");
  assert.equal(turns[0]!.sessionId, "session-xyz");
  assert.equal(turns[0]!.cwd, null);
  assert.equal(turns[0]!.entrypoint, null);
});

// --- model mixing ---------------------------------------------------------------

test("an interaction spanning more than one model is skipped and reported, never attributed to one", () => {
  const text =
    [
      sessionStart(),
      turnStart("0", "int-1"),
      usageRecord("claude-sonnet-5.5", {}, "2026-10-09T07:00:00.000Z"),
      turnEnd("0"),
      turnStart("1", "int-1"),
      usageRecord("gpt-6-sol", {}, "2026-10-09T07:00:05.000Z"),
      turnEnd("1"),
    ].join("\n") + "\n";
  const { turns, diagnostics } = parseCopilotCliChunk(text, "f.jsonl");
  assert.equal(turns.length, 0);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.kind, "unknown-shape");
  assert.match(diagnostics[0]!.detail, /spans 2 models/);
});

// --- malformed / sparse input ----------------------------------------------------

test("a usage_record seen before any turn_start is skipped and reported", () => {
  const text = [sessionStart(), usageRecord("claude-sonnet-5.5")].join("\n") + "\n";
  const { turns, diagnostics } = parseCopilotCliChunk(text, "f.jsonl");
  assert.equal(turns.length, 0);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0]!.detail, /outside any turn_start\/turn_end bracket/);
});

test("skips corrupt lines, keeps good ones, and reports the corruption", () => {
  const good = [sessionStart(), interaction("0", "int-1")].join("\n");
  const text = good + "\n" + '{"type": "session.usage_record", not json\n' + "\n";
  const { turns, diagnostics } = parseCopilotCliChunk(text, "f.jsonl");
  assert.equal(turns.length, 1);
  assert.equal(diagnostics.some((d) => d.kind === "parse-error"), true);
});

test("an interaction with no usage_record produces no turn and no diagnostic", () => {
  const text = [sessionStart(), turnStart("0", "int-1"), turnEnd("0")].join("\n") + "\n";
  const { turns, diagnostics } = parseCopilotCliChunk(text, "f.jsonl");
  assert.equal(turns.length, 0);
  assert.equal(diagnostics.length, 0);
});

test("never reads message or tool-call content — structure only", () => {
  const secret = line("tool.execution_complete", {
    toolCallId: "t1",
    arguments: { file_text: "SECRET SOURCE CODE" },
    result: { content: "SECRET SOURCE CODE" },
  });
  const text = [sessionStart(), secret, interaction("0", "int-1")].join("\n") + "\n";
  const { turns } = parseCopilotCliChunk(text, "f.jsonl");
  assert.equal(JSON.stringify(turns).includes("SECRET"), false);
});

// --- file discovery --------------------------------------------------------------

function sessionStateTree(): string {
  const root = mkdtempSync(join(tmpdir(), "modelog-copilot-cli-"));
  const session = join(root, "e8a4dab4-dec8-475f-8075-ad4f64589673");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "events.jsonl"), "");
  writeFileSync(join(session, "workspace.yaml"), "");
  mkdirSync(join(session, "checkpoints"), { recursive: true });
  mkdirSync(join(root, ".session-operation-locks"), { recursive: true });
  return root;
}

test("findFiles matches only <sessionId>/events.jsonl directly under the root", () => {
  const found = findCopilotCliLogs(sessionStateTree()).map((p) => p.split("/").slice(-2).join("/"));
  assert.deepEqual(found, ["e8a4dab4-dec8-475f-8075-ad4f64589673/events.jsonl"]);
});

test("a missing or empty root yields no files rather than throwing", () => {
  assert.deepEqual(findCopilotCliLogs(join(tmpdir(), "does-not-exist-at-all")), []);
  assert.deepEqual(findCopilotCliLogs(mkdtempSync(join(tmpdir(), "modelog-copilot-cli-empty-"))), []);
});

test("the adapter re-reads whole files, because a turn spans many lines, and reports as copilot", () => {
  assert.equal(copilotCliAdapter.mode, "whole-file");
  assert.equal(copilotCliAdapter.source, "copilot");
});
