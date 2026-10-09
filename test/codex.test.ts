import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexChunk, codexAdapter } from "../src/ingest/codex.ts";
import { CAPTURE_VERSION } from "../src/ingest/capture.ts";

const DIR = join(import.meta.dirname, "fixtures", "codex");

function fixture(name: string): string {
  return readFileSync(join(DIR, name), "utf8");
}

const SINGLE_TURN = () => fixture("single-turn-session.jsonl");
const MODEL_SWITCH = () => fixture("model-switch-session.jsonl");

// --- small record builders, matching the real {timestamp, ordinal, type, payload} shape ---

function line(type: string, payload: Record<string, unknown>, timestamp = "2026-10-09T07:28:10.000Z"): string {
  return JSON.stringify({ timestamp, ordinal: 0, type, payload });
}

function sessionMeta(over: Record<string, unknown> = {}): string {
  return line("session_meta", {
    session_id: "sess-1",
    cwd: "/workspace/example",
    originator: "codex-tui",
    cli_version: "0.162.0",
    source: "vscode",
    model_provider: "openai",
    git: { branch: "main" },
    ...over,
  });
}

function turnContext(turnId: string, model: string): string {
  return line("turn_context", { turn_id: turnId, root_turn_id: turnId, model });
}

function taskStarted(turnId: string, over: Record<string, unknown> = {}): string {
  return line("event_msg", {
    type: "task_started",
    turn_id: turnId,
    root_turn_id: turnId,
    turn_attribution: { turn_id: turnId, turn_trigger: "user", parent_turn_id: null, root_turn_id: turnId },
    ...over,
  });
}

function threadSettingsApplied(model: string): string {
  return line("event_msg", {
    type: "thread_settings_applied",
    thread_id: "sess-1",
    thread_settings: { model, model_provider_id: "openai", service_tier: "default" },
  });
}

const ZERO_USAGE = {
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: 0,
};

function usageRecord(
  turnId: string,
  cumulative: Partial<typeof ZERO_USAGE>,
  over: Record<string, unknown> = {},
  timestamp = "2026-10-09T07:28:10.000Z",
): string {
  return line(
    "token_usage_record",
    {
      thread_id: "sess-1",
      turn_id: turnId,
      session_id: "sess-1",
      root_turn_id: turnId,
      response_id: "resp-1",
      usage: { ...ZERO_USAGE, ...cumulative },
      turn_token_usage: { ...ZERO_USAGE, ...cumulative },
      thread_token_usage: { ...ZERO_USAGE, ...cumulative },
      ...over,
    },
    timestamp,
  );
}

// --- against the two real captured sessions ---------------------------------

test("a single-turn real session produces one turn aggregating every round-trip", () => {
  const { turns, diagnostics } = parseCodexChunk(SINGLE_TURN(), "rollout.jsonl");
  assert.equal(turns.length, 1);
  assert.equal(diagnostics.length, 0);

  const t = turns[0]!;
  assert.equal(t.model, "gpt-6.1-sol");
  assert.equal(t.source, "codex");
  // 11 token_usage_record lines in the real capture.
  assert.equal(t.iterations, 11);
  // Last record's turn_token_usage: input 315518, cached 270720, output 1316,
  // reasoning 75, cache_write 0 — measured from the committed fixture.
  assert.equal(t.inputTokens, 315518 - 270720);
  assert.equal(t.cacheReadTokens, 270720);
  assert.equal(t.cacheWrite5mTokens, 0);
  assert.equal(t.cacheWrite1hTokens, 0);
  assert.equal(t.outputTokens, 1316);
  assert.equal(t.thinkingTokens, 75);
  assert.equal(t.tokenBreakdown, "reported");
  assert.equal(t.costNanoAiu, null);
  assert.equal(t.speed, null);
  assert.equal(t.inferenceGeo, null);
  assert.equal(t.entrypoint, "codex-tui");
  assert.equal(t.isSidechain, false);
  assert.equal(t.sessionId, "01a11f8f-b93e-7d40-acd1-77ddbd5cf1eb");
  assert.equal(t.cwd, "/home/scott/tmp-dev/modelog");
  assert.equal(t.gitBranch, "dev");
  assert.equal(t.captureVersion, CAPTURE_VERSION);
});

test("a model switch mid-session produces turns on both models, in order", () => {
  const { turns, diagnostics } = parseCodexChunk(MODEL_SWITCH(), "rollout.jsonl");
  assert.equal(diagnostics.length, 0);
  assert.equal(turns.length, 11);
  // 9 turns on the original model, then 2 on the switched-to model — measured
  // from the real capture's turn_context/thread_settings_applied sequence.
  assert.deepEqual(
    turns.map((t) => t.model),
    [...Array(9).fill("gpt-6.1-sol"), ...Array(2).fill("gpt-6-astra")],
  );
  const totalIterations = turns.reduce((sum, t) => sum + t.iterations, 0);
  assert.equal(totalIterations, 66);
  for (const t of turns) assert.equal(t.tokenBreakdown, "reported");
});

// --- turn/iteration aggregation ----------------------------------------------

test("a turn is the whole group of token_usage_record lines sharing a turn_id, not one each", () => {
  const text =
    [
      sessionMeta(),
      turnContext("t1", "gpt-6.1-sol"),
      usageRecord("t1", { input_tokens: 100, output_tokens: 10, total_tokens: 110 }, {}, "2026-10-09T07:00:00.000Z"),
      usageRecord("t1", { input_tokens: 150, output_tokens: 20, total_tokens: 170 }, {}, "2026-10-09T07:00:05.000Z"),
      usageRecord("t1", { input_tokens: 200, output_tokens: 30, total_tokens: 230 }, {}, "2026-10-09T07:00:10.000Z"),
    ].join("\n") + "\n";
  const { turns } = parseCodexChunk(text, "f.jsonl");
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.iterations, 3);
});

test("totals come from the last cumulative turn_token_usage, never a sum of per-record deltas", () => {
  const text =
    [
      sessionMeta(),
      turnContext("t1", "gpt-6.1-sol"),
      // If these were summed instead of taking the last cumulative snapshot,
      // input would read 300 (100+200) rather than the real total of 200.
      usageRecord("t1", { input_tokens: 100, cached_input_tokens: 0 }, {}, "2026-10-09T07:00:00.000Z"),
      usageRecord("t1", { input_tokens: 200, cached_input_tokens: 50 }, {}, "2026-10-09T07:00:05.000Z"),
    ].join("\n") + "\n";
  const { turns } = parseCodexChunk(text, "f.jsonl");
  assert.equal(turns[0]!.inputTokens, 200 - 50);
  assert.equal(turns[0]!.cacheReadTokens, 50);
});

test("input_tokens is reduced by cached_input_tokens — Codex's count is inclusive, not exclusive", () => {
  const text =
    [sessionMeta(), turnContext("t1", "gpt-6.1-sol"), usageRecord("t1", { input_tokens: 1000, cached_input_tokens: 400 })].join(
      "\n",
    ) + "\n";
  const { turns } = parseCodexChunk(text, "f.jsonl");
  assert.equal(turns[0]!.inputTokens, 600);
  assert.equal(turns[0]!.cacheReadTokens, 400);
});

// --- model resolution ---------------------------------------------------------

test("falls back to the preceding thread_settings_applied when no turn_context exists for a turn", () => {
  const text =
    [sessionMeta(), threadSettingsApplied("gpt-6-astra"), usageRecord("t1", { input_tokens: 10 })].join("\n") + "\n";
  const { turns, diagnostics } = parseCodexChunk(text, "f.jsonl");
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.model, "gpt-6-astra");
  assert.equal(diagnostics.length, 0);
});

test("a disagreeing turn_context repeat uses the later value and is flagged", () => {
  const text =
    [
      sessionMeta(),
      turnContext("t1", "gpt-6.1-sol"),
      turnContext("t1", "gpt-6-astra"),
      usageRecord("t1", { input_tokens: 10 }),
    ].join("\n") + "\n";
  const { turns, diagnostics } = parseCodexChunk(text, "f.jsonl");
  assert.equal(turns[0]!.model, "gpt-6-astra");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.kind, "unknown-shape");
  assert.match(diagnostics[0]!.detail, /conflicting turn_context models/);
});

test("a turn with no resolvable model is skipped and reported, never guessed", () => {
  const text = [sessionMeta(), usageRecord("t1", { input_tokens: 10 })].join("\n") + "\n";
  const { turns, diagnostics } = parseCodexChunk(text, "f.jsonl");
  assert.equal(turns.length, 0);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.kind, "unknown-shape");
  assert.match(diagnostics[0]!.detail, /no resolvable model/);
});

// --- cache writes --------------------------------------------------------------

test("a nonzero cache write lands in the 5-minute bucket, and the TTL assumption is declared", () => {
  const text =
    [sessionMeta(), turnContext("t1", "gpt-6.1-sol"), usageRecord("t1", { cache_write_input_tokens: 500 })].join(
      "\n",
    ) + "\n";
  const { turns, diagnostics } = parseCodexChunk(text, "f.jsonl");
  assert.equal(turns[0]!.cacheWrite5mTokens, 500);
  assert.equal(turns[0]!.cacheWrite1hTokens, 0);
  assert.equal(diagnostics.some((d) => d.kind === "assumed-cache-ttl"), true);
});

test("a zero cache write is not flagged — the assumption only matters when it applies", () => {
  const text =
    [sessionMeta(), turnContext("t1", "gpt-6.1-sol"), usageRecord("t1", { cache_write_input_tokens: 0 })].join(
      "\n",
    ) + "\n";
  const { diagnostics } = parseCodexChunk(text, "f.jsonl");
  assert.equal(diagnostics.some((d) => d.kind === "assumed-cache-ttl"), false);
});

// --- subagent / sidechain detection --------------------------------------------

test("a turn whose root_turn_id differs from its turn_id is a sidechain", () => {
  const text =
    [
      sessionMeta(),
      turnContext("t1", "gpt-6.1-sol"),
      usageRecord("t1", { input_tokens: 10 }, { root_turn_id: "root-1" }),
    ].join("\n") + "\n";
  const { turns } = parseCodexChunk(text, "f.jsonl");
  assert.equal(turns[0]!.isSidechain, true);
});

test("a turn whose task_started trigger is not 'user' is a sidechain", () => {
  const text =
    [
      sessionMeta(),
      taskStarted("t1", { turn_attribution: { turn_id: "t1", turn_trigger: "subagent", root_turn_id: "t1" } }),
      turnContext("t1", "gpt-6.1-sol"),
      usageRecord("t1", { input_tokens: 10 }),
    ].join("\n") + "\n";
  const { turns } = parseCodexChunk(text, "f.jsonl");
  assert.equal(turns[0]!.isSidechain, true);
});

test("a normal user-triggered, non-diverging turn is not a sidechain", () => {
  const text =
    [sessionMeta(), taskStarted("t1"), turnContext("t1", "gpt-6.1-sol"), usageRecord("t1", { input_tokens: 10 })].join(
      "\n",
    ) + "\n";
  const { turns } = parseCodexChunk(text, "f.jsonl");
  assert.equal(turns[0]!.isSidechain, false);
});

// --- malformed / sparse input ----------------------------------------------------

test("skips corrupt lines, keeps good ones, and reports the corruption", () => {
  const good = [sessionMeta(), turnContext("t1", "gpt-6.1-sol"), usageRecord("t1", { input_tokens: 10 })].join("\n");
  const text = good + "\n" + '{"type": "token_usage_record", not json\n' + "\n";
  const { turns, diagnostics } = parseCodexChunk(text, "f.jsonl");
  assert.equal(turns.length, 1);
  assert.equal(diagnostics.some((d) => d.kind === "parse-error"), true);
});

test("a turn_id with no billed calls produces no turn and no diagnostic", () => {
  const text = [sessionMeta(), taskStarted("t1"), turnContext("t1", "gpt-6.1-sol")].join("\n") + "\n";
  const { turns, diagnostics } = parseCodexChunk(text, "f.jsonl");
  assert.equal(turns.length, 0);
  assert.equal(diagnostics.length, 0);
});

test("never reads prompt, reasoning or tool-call content — structure only", () => {
  const secret = line("response_item", {
    type: "message",
    role: "user",
    content: [{ type: "text", text: "SECRET SOURCE CODE" }],
  });
  const text =
    [sessionMeta(), secret, turnContext("t1", "gpt-6.1-sol"), usageRecord("t1", { input_tokens: 10 })].join("\n") +
    "\n";
  const { turns } = parseCodexChunk(text, "f.jsonl");
  assert.equal(JSON.stringify(turns).includes("SECRET"), false);
});

// --- file discovery --------------------------------------------------------------

function sessionsTree(): string {
  const root = mkdtempSync(join(tmpdir(), "modelog-codex-"));
  const day = join(root, "2026", "10", "09");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "rollout-2026-10-09T09-27-55-01a11f8f.jsonl"), "");
  writeFileSync(join(day, "not-a-rollout.jsonl"), "");
  writeFileSync(join(day, "rollout-notes.txt"), "");
  return root;
}

test("findFiles matches only rollout-*.jsonl, recursively under the sessions root", () => {
  const found = codexAdapter.findFiles(sessionsTree()).map((p) => p.split("/").pop());
  assert.deepEqual(found, ["rollout-2026-10-09T09-27-55-01a11f8f.jsonl"]);
});

test("a missing or empty root yields no files rather than throwing", () => {
  assert.deepEqual(codexAdapter.findFiles(join(tmpdir(), "does-not-exist-at-all")), []);
  assert.deepEqual(codexAdapter.findFiles(mkdtempSync(join(tmpdir(), "modelog-codex-empty-"))), []);
});

test("the adapter re-reads whole files, because a turn spans many lines", () => {
  assert.equal(codexAdapter.mode, "whole-file");
  assert.equal(codexAdapter.source, "codex");
});

