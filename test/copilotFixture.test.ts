import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the committed Copilot fixtures against ever carrying prompt or code
 * content into this public repo.
 *
 * The fixtures are redacted captures of real sessions, produced by
 * `scripts/redact-copilot-fixture.mjs`. That script redacts by allowlist, and
 * this test re-asserts the same allowlist against what is actually on disk —
 * so a re-capture that bypassed the script, or a Copilot update that added a
 * new content-bearing attr, fails here rather than in a push.
 */

const DIR = join(import.meta.dirname, "fixtures", "copilot");

const SAFE_TOP_LEVEL = new Set([
  "v", "ts", "dur", "sid", "type", "name", "spanId", "parentSpanId", "status", "attrs",
]);

const SAFE_ATTRS = new Set([
  "copilotVersion", "vscodeVersion", "parentSessionId", "label",
  "turnId", "childSessionId", "childLogFile",
  "model", "debugName", "inputTokens", "outputTokens", "cachedTokens",
  "ttft", "responseId", "maxTokens", "temperature", "topP",
  "copilotUsageNanoAiu", "systemPromptFile", "toolsFile", "error",
]);

/** Attrs Copilot writes that are prompt or code content. Named explicitly so
 *  the test states what it is defending against, not just what it permits. */
const CONTENT_ATTRS = [
  "content", "userRequest", "inputMessages", "response", "reasoning",
  "args", "result", "details",
];

function fixtureLines(): { file: string; line: number; record: Record<string, unknown> }[] {
  const out: { file: string; line: number; record: Record<string, unknown> }[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".jsonl"))) {
    const text = readFileSync(join(DIR, file), "utf8");
    text.split("\n").filter(Boolean).forEach((line, i) => {
      out.push({ file, line: i + 1, record: JSON.parse(line) });
    });
  }
  return out;
}

test("every committed fixture record is parseable and non-empty", () => {
  const records = fixtureLines();
  assert.ok(records.length > 0, "no fixture records found — did the directory move?");
});

test("no fixture record carries a key outside the structural allowlist", () => {
  for (const { file, line, record } of fixtureLines()) {
    for (const key of Object.keys(record)) {
      assert.ok(
        SAFE_TOP_LEVEL.has(key),
        `${file}:${line} has non-allowlisted top-level key "${key}"`,
      );
    }
    const attrs = (record.attrs ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(attrs)) {
      assert.ok(
        SAFE_ATTRS.has(key),
        `${file}:${line} has non-allowlisted attr "${key}"`,
      );
    }
  }
});

test("no fixture record carries a known content-bearing attr", () => {
  for (const { file, line, record } of fixtureLines()) {
    const attrs = (record.attrs ?? {}) as Record<string, unknown>;
    for (const banned of CONTENT_ATTRS) {
      assert.equal(attrs[banned], undefined, `${file}:${line} leaked "${banned}"`);
    }
  }
});

/**
 * A redacted capture should be almost entirely numbers and short identifiers.
 * A long string is the shape prompt content would take if it ever slipped
 * through a future allowlist change, so it fails here on length alone.
 */
test("no fixture string value is long enough to be prose", () => {
  for (const { file, line, record } of fixtureLines()) {
    const attrs = (record.attrs ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(attrs)) {
      if (typeof value !== "string") continue;
      assert.ok(
        value.length <= 80,
        `${file}:${line} attr "${key}" is ${value.length} chars — too long to be an identifier`,
      );
    }
  }
});
