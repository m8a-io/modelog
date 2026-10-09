import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the committed Codex fixtures against ever carrying prompt, code, or
 * system-prompt content into this public repo.
 *
 * The fixtures are redacted captures of real sessions, produced by
 * `scripts/redact-codex-fixture.mjs`. That script redacts by allowlist, and
 * this test re-asserts the same allowlist against what is actually on disk —
 * so a re-capture that bypassed the script, or a Codex update that added a
 * new content-bearing field, fails here rather than in a push.
 */

const DIR = join(import.meta.dirname, "fixtures", "codex");

const SAFE_TOP_LEVEL = new Set(["timestamp", "ordinal", "type", "payload"]);

const SAFE_USAGE_KEYS = new Set([
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
]);

const SAFE_PAYLOAD_KEYS: Record<string, Set<string>> = {
  session_meta: new Set([
    "session_id",
    "id",
    "cwd",
    "originator",
    "cli_version",
    "source",
    "thread_source",
    "model_provider",
    "git",
  ]),
  turn_context: new Set(["turn_id", "root_turn_id", "model"]),
  token_usage_record: new Set([
    "thread_id",
    "turn_id",
    "session_id",
    "root_turn_id",
    "response_id",
    "usage",
    "turn_token_usage",
    "thread_token_usage",
  ]),
};

/** event_msg's own `type` field picks its sub-shape. */
const SAFE_EVENT_MSG_KEYS: Record<string, Set<string>> = {
  task_started: new Set([
    "type",
    "turn_id",
    "root_turn_id",
    "started_at",
    "model_context_window",
    "collaboration_mode_kind",
    "turn_attribution",
  ]),
  task_complete: new Set([
    "type",
    "turn_id",
    "root_turn_id",
    "started_at",
    "completed_at",
    "duration_ms",
    "time_to_first_token_ms",
  ]),
};

/** Fields known to carry prompt, code, or system-prompt text. Named explicitly
 *  so the test states what it defends against, not just what it permits. */
const CONTENT_KEYS = [
  "base_instructions",
  "developer_instructions",
  "content",
  "last_agent_message",
  "args",
  "result",
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
      assert.ok(SAFE_TOP_LEVEL.has(key), `${file}:${line} has non-allowlisted top-level key "${key}"`);
    }

    const type = record.type as string;
    const payload = (record.payload ?? {}) as Record<string, unknown>;

    if (type === "event_msg") {
      const subtype = payload.type as string | undefined;
      const allowed = subtype ? SAFE_EVENT_MSG_KEYS[subtype] : undefined;
      for (const key of Object.keys(payload)) {
        assert.ok(
          allowed ? allowed.has(key) : key === "type",
          `${file}:${line} event_msg/${subtype} has non-allowlisted key "${key}"`,
        );
      }
      continue;
    }

    const allowed = SAFE_PAYLOAD_KEYS[type];
    for (const key of Object.keys(payload)) {
      if (allowed) {
        assert.ok(allowed.has(key), `${file}:${line} ${type} has non-allowlisted key "${key}"`);
      } else {
        // Content-bearing record types (response_item, world_state, ...):
        // structure only — nothing but `type` survives redaction.
        assert.ok(key === "type", `${file}:${line} ${type} has non-allowlisted key "${key}"`);
      }
    }

    if (type === "token_usage_record") {
      for (const bucket of ["usage", "turn_token_usage", "thread_token_usage"] as const) {
        const values = (payload[bucket] ?? {}) as Record<string, unknown>;
        for (const key of Object.keys(values)) {
          assert.ok(SAFE_USAGE_KEYS.has(key), `${file}:${line} ${bucket} has non-allowlisted key "${key}"`);
        }
      }
    }
  }
});

test("no fixture record carries a known content-bearing field", () => {
  for (const { file, line, record } of fixtureLines()) {
    const json = JSON.stringify(record);
    for (const banned of CONTENT_KEYS) {
      assert.ok(!json.includes(`"${banned}"`), `${file}:${line} leaked "${banned}"`);
    }
  }
});

/**
 * A redacted capture should be almost entirely numbers and short
 * identifiers. A long string is the shape prompt content would take if it
 * ever slipped through a future allowlist change, so it fails here on
 * length alone.
 */
test("no fixture string value is long enough to be prose", () => {
  for (const { file, line, record } of fixtureLines()) {
    const walk = (value: unknown, path: string): void => {
      if (typeof value === "string") {
        assert.ok(value.length <= 80, `${file}:${line} ${path} is ${value.length} chars — too long to be an identifier`);
      } else if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}[${i}]`));
      } else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
      }
    };
    walk(record, "$");
  }
});
