import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the committed Copilot CLI fixtures against ever carrying prompt,
 * code, or tool-call content into this public repo.
 *
 * The fixtures are redacted captures of real sessions, produced by
 * `scripts/redact-copilot-cli-fixture.mjs`. That script redacts by
 * allowlist, and this test re-asserts the same allowlist against what is
 * actually on disk — so a re-capture that bypassed the script, or a Copilot
 * CLI update that added a new content-bearing field, fails here rather than
 * in a push.
 */

const DIR = join(import.meta.dirname, "fixtures", "copilot-cli");

const SAFE_TOP_LEVEL = new Set(["type", "data", "id", "timestamp", "parentId"]);

const SAFE_CONTEXT_KEYS = new Set([
  "cwd",
  "gitRoot",
  "repository",
  "hostType",
  "repositoryHost",
  "branch",
  "headCommit",
]);

const SAFE_USAGE_KEYS = new Set([
  "model",
  "provider",
  "modelDisplayName",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "cost",
  "duration",
  "timeToFirstTokenMs",
  "outputTtftMs",
  "cacheExpiresAt",
  "interTokenLatencyMs",
  "initiator",
  "interactionType",
  "isByok",
  "isAuto",
  "maxPromptTokens",
  "maxOutputTokens",
  "transport",
  "requestBodyBytes",
  "apiCallId",
  "providerCallId",
  "serviceRequestId",
  "rte",
  "apiEndpoint",
  "accounting",
  "copilotUsage",
  "aiCreditsStatus",
  "reasoningEffort",
  "reasoningSummary",
  "availableToolCount",
  "toolTokenCount",
  "frontierSource",
  "cacheTtlSeconds",
  "cacheDetailsReported",
  "numToolCalls",
  "toolCounts",
  "finishReason",
  "contentFilterTriggered",
]);

const SAFE_DATA_KEYS: Record<string, Set<string>> = {
  "session.start": new Set([
    "sessionId",
    "version",
    "producer",
    "copilotVersion",
    "startTime",
    "contextTier",
    "alreadyInUse",
    "remoteSteerable",
    "context",
  ]),
  "session.model_change": new Set(["source", "contextTier", "newModel", "previousModel", "reasoningEffort"]),
  "assistant.turn_start": new Set(["turnId", "interactionId"]),
  "assistant.turn_end": new Set(["turnId"]),
  "session.usage_record": new Set(["usage"]),
  "tool.execution_start": new Set(["toolCallId", "toolName", "turnId", "model"]),
  "tool.execution_complete": new Set(["toolCallId", "toolName", "turnId", "model", "interactionId", "success", "rte"]),
};

/** Types not in SAFE_DATA_KEYS (user.message, system.message, assistant.message,
 *  session.usage_checkpoint, session.shutdown) keep no data at all. */

/** Fields known to carry prompt, code, or tool-call content. Named explicitly
 *  so the test states what it defends against, not just what it permits. */
const CONTENT_KEYS = ["arguments", "result", "fileEdits", "toolTelemetry", "content", "text"];

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
    const data = (record.data ?? {}) as Record<string, unknown>;
    const allowed = SAFE_DATA_KEYS[type];

    for (const key of Object.keys(data)) {
      assert.ok(allowed ? allowed.has(key) : false, `${file}:${line} ${type} has non-allowlisted key "${key}"`);
    }

    if (type === "session.start" && data.context) {
      for (const key of Object.keys(data.context as Record<string, unknown>)) {
        assert.ok(SAFE_CONTEXT_KEYS.has(key), `${file}:${line} session.start context has non-allowlisted key "${key}"`);
      }
    }

    if (type === "session.usage_record" && data.usage) {
      for (const key of Object.keys(data.usage as Record<string, unknown>)) {
        assert.ok(SAFE_USAGE_KEYS.has(key), `${file}:${line} usage has non-allowlisted key "${key}"`);
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
