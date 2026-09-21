import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChunk } from "../src/ingest/claudeCode.ts";

const assistant = (over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    uuid: "u1",
    sessionId: "s1",
    timestamp: "2026-09-20T10:00:00.000Z",
    cwd: "/workspace/example",
    gitBranch: "main",
    message: {
      role: "assistant",
      model: "claude-sonnet-5",
      usage: {
        input_tokens: 2,
        output_tokens: 352,
        cache_read_input_tokens: 28_167,
        cache_creation_input_tokens: 21_726,
        cache_creation: { ephemeral_1h_input_tokens: 21_726, ephemeral_5m_input_tokens: 0 },
        output_tokens_details: { thinking_tokens: 56 },
        iterations: [{ type: "message" }],
        ...usage,
      },
      ...(over.message as object ?? {}),
    },
    ...over,
  });

test("extracts a well-formed assistant record", () => {
  const { turns, diagnostics } = parseChunk(assistant() + "\n", "f.jsonl");
  assert.equal(turns.length, 1);
  assert.equal(diagnostics.length, 0);
  const t = turns[0]!;
  assert.equal(t.model, "claude-sonnet-5");
  assert.equal(t.inputTokens, 2);
  assert.equal(t.cacheReadTokens, 28_167);
  assert.equal(t.cacheWrite1hTokens, 21_726);
  assert.equal(t.cacheWrite5mTokens, 0);
  assert.equal(t.thinkingTokens, 56);
  assert.equal(t.iterations, 1);
  assert.equal(t.gitBranch, "main");
  assert.equal(t.ts, Date.parse("2026-09-20T10:00:00.000Z"));
});

test("ignores non-assistant record types", () => {
  const lines = ["user", "attachment", "queue-operation", "ai-title", "file-history-snapshot"]
    .map((type) => JSON.stringify({ type, uuid: "x", sessionId: "s1" }))
    .join("\n") + "\n";
  const { turns, diagnostics } = parseChunk(lines, "f.jsonl");
  assert.equal(turns.length, 0);
  assert.equal(diagnostics.length, 0);
});

test("drops <synthetic> records silently — they are not API calls", () => {
  const rec = JSON.parse(assistant());
  rec.message.model = "<synthetic>";
  const { turns, diagnostics } = parseChunk(JSON.stringify(rec) + "\n", "f.jsonl");
  assert.equal(turns.length, 0);
  assert.equal(diagnostics.length, 0, "a synthetic record is expected, not a problem");
});

test("counts iterations — a turn is not an inference call", () => {
  const { turns } = parseChunk(
    assistant({}, { iterations: [{ type: "message" }, { type: "message" }, { type: "message" }] }) + "\n",
    "f.jsonl",
  );
  assert.equal(turns[0]!.iterations, 3);
});

test("holds a truncated final line for the next read", () => {
  const full = assistant() + "\n";
  const partial = full.slice(0, -40);
  const first = parseChunk(partial, "f.jsonl");
  assert.equal(first.turns.length, 0);
  assert.ok(first.remainder.length > 0);
  assert.equal(first.diagnostics.length, 0, "a mid-write read is not corruption");

  // Next read resumes from the held remainder.
  const second = parseChunk(first.remainder + full.slice(partial.length), "f.jsonl");
  assert.equal(second.turns.length, 1);
  assert.equal(second.remainder, "");
});

test("skips corrupt lines, keeps good ones, and reports the corruption", () => {
  const text = assistant() + "\n" + "{not json at all\n" + assistant() + "\n";
  const { turns, diagnostics } = parseChunk(text, "f.jsonl");
  assert.equal(turns.length, 2);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.kind, "parse-error");
  assert.equal(diagnostics[0]!.line, 2);
});

test("an absent cache_creation split is assumed 5m — and flagged", () => {
  const rec = JSON.parse(assistant());
  delete rec.message.usage.cache_creation;
  const { turns, diagnostics } = parseChunk(JSON.stringify(rec) + "\n", "f.jsonl");
  assert.equal(turns[0]!.cacheWrite5mTokens, 21_726);
  assert.equal(turns[0]!.cacheWrite1hTokens, 0);
  assert.equal(diagnostics[0]!.kind, "assumed-cache-ttl");
});

test("a split that disagrees with the total is flagged, not silently trusted", () => {
  const { turns, diagnostics } = parseChunk(
    assistant({}, {
      cache_creation_input_tokens: 99_999,
      cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 20 },
    }) + "\n",
    "f.jsonl",
  );
  assert.equal(turns.length, 1);
  assert.equal(diagnostics.some((d) => d.detail.includes("!=")), true);
});

test("an assistant record with no usage is skipped and reported", () => {
  const rec = JSON.parse(assistant());
  delete rec.message.usage;
  const { turns, diagnostics } = parseChunk(JSON.stringify(rec) + "\n", "f.jsonl");
  assert.equal(turns.length, 0);
  assert.equal(diagnostics[0]!.kind, "unknown-shape");
});

test("never reads message content — prompts and code stay out of the store", () => {
  const rec = JSON.parse(assistant());
  rec.message.content = [{ type: "text", text: "SECRET SOURCE CODE" }];
  const { turns } = parseChunk(JSON.stringify(rec) + "\n", "f.jsonl");
  assert.equal(JSON.stringify(turns[0]).includes("SECRET"), false);
});
