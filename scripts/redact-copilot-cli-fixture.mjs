#!/usr/bin/env node
// Redacts a real GitHub Copilot CLI session log into a committable test fixture.
//
// This repo is public. `~/.copilot/session-state/<id>/events.jsonl` carries
// full prompt and assistant text (`user.message`, `assistant.message`,
// `system.message`) and tool call arguments/results (`tool.execution_start`,
// `tool.execution_complete` — file contents, diffs, shell output) inline.
//
// So, same as scripts/redact-codex-fixture.mjs and
// scripts/redact-copilot-fixture.mjs, redaction here is an ALLOWLIST, never a
// denylist: every field is dropped unless it is named below. A Copilot CLI
// update that adds a new content-bearing field therefore leaks nothing — it
// is simply not copied.
//
//   node scripts/redact-copilot-cli-fixture.mjs <source.jsonl> <dest.jsonl>
//
// Verify the result with test/copilotCliFixture.test.ts, which re-asserts the
// same allowlist against whatever is actually committed.

import { readFileSync, writeFileSync } from "node:fs";

/** Every record carries these four; none of them is content. */
const SAFE_TOP_LEVEL = ["type", "data", "id", "timestamp", "parentId"];

const SAFE_CONTEXT_KEYS = [
  "cwd",
  "gitRoot",
  "repository",
  "hostType",
  "repositoryHost",
  "branch",
  "headCommit",
];

const SAFE_USAGE_KEYS = [
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
];

function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (obj?.[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

/** Per-type `data` allowlist. A type absent here keeps an empty `data`. */
function redactData(type, data) {
  if (!data || typeof data !== "object") return data;

  switch (type) {
    case "session.start":
      return {
        ...pick(data, ["sessionId", "version", "producer", "copilotVersion", "startTime", "contextTier", "alreadyInUse", "remoteSteerable"]),
        ...(data.context ? { context: pick(data.context, SAFE_CONTEXT_KEYS) } : {}),
      };

    case "session.model_change":
      return pick(data, ["source", "contextTier", "newModel", "previousModel", "reasoningEffort"]);

    case "assistant.turn_start":
      return pick(data, ["turnId", "interactionId"]);

    case "assistant.turn_end":
      return pick(data, ["turnId"]);

    case "session.usage_record":
      return data.usage ? { usage: pick(data.usage, SAFE_USAGE_KEYS) } : {};

    case "tool.execution_start":
      // Deliberately excludes `arguments` — the tool call's input (file
      // contents, shell commands, ...).
      return pick(data, ["toolCallId", "toolName", "turnId", "model"]);

    case "tool.execution_complete":
      // Deliberately excludes `result`, `fileEdits`, `toolTelemetry` — all
      // carry file contents, diffs, or shell output.
      return pick(data, ["toolCallId", "toolName", "turnId", "model", "interactionId", "success", "rte"]);

    // user.message, system.message, assistant.message carry prompt/response
    // text directly. session.usage_checkpoint and session.shutdown are not
    // read by the adapter and nest the same per-model usage totals as
    // session.usage_record plus a list of edited file paths
    // (accountingSnapshot.codeChanges.filesModified) — structure only.
    default:
      return {};
  }
}

function redact(record) {
  const out = pick(record, SAFE_TOP_LEVEL);
  out.data = redactData(record.type, record.data);
  return out;
}

const [, , source, dest] = process.argv;
if (!source || !dest) {
  console.error("usage: redact-copilot-cli-fixture.mjs <source.jsonl> <dest.jsonl>");
  process.exit(1);
}

const lines = readFileSync(source, "utf8").split("\n").filter(Boolean);
const redacted = lines.map((line) => JSON.stringify(redact(JSON.parse(line))));
writeFileSync(dest, redacted.join("\n") + "\n");

console.error(`${lines.length} records -> ${dest}`);
