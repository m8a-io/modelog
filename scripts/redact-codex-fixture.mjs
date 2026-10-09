#!/usr/bin/env node
// Redacts a real Codex rollout log into a committable test fixture.
//
// This repo is public. A Codex rollout carries its full system prompt
// (session_meta.base_instructions, turn_context.collaboration_mode.settings
// .developer_instructions) and every prompt/response/tool-call text
// (response_item payloads, task_complete.last_agent_message) inline.
//
// So, same as scripts/redact-copilot-fixture.mjs, redaction here is an
// ALLOWLIST, never a denylist: every field is dropped unless it is named
// below. A Codex update that adds a new content-bearing field therefore
// leaks nothing — it is simply not copied.
//
//   node scripts/redact-codex-fixture.mjs <source.jsonl> <dest.jsonl>
//
// Verify the result with test/codexFixture.test.ts, which re-asserts the
// same allowlist against whatever is actually committed.

import { readFileSync, writeFileSync } from "node:fs";

/** Every record carries these three; none of them is content. */
const SAFE_TOP_LEVEL = ["timestamp", "ordinal", "type"];

/** usage/turn_token_usage/thread_token_usage are all-numeric token counts. */
const SAFE_USAGE_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (obj?.[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

/** Per-record-type payload allowlist. A type absent here keeps no payload at all. */
function redactPayload(type, payload) {
  if (!payload || typeof payload !== "object") return payload;

  switch (type) {
    case "session_meta":
      return {
        ...pick(payload, [
          "session_id",
          "id",
          "cwd",
          "originator",
          "cli_version",
          "source",
          "thread_source",
          "model_provider",
        ]),
        ...(payload.git?.branch !== undefined ? { git: { branch: payload.git.branch } } : {}),
      };

    case "turn_context":
      return pick(payload, ["turn_id", "root_turn_id", "model"]);

    case "token_usage_record":
      return {
        ...pick(payload, ["thread_id", "turn_id", "session_id", "root_turn_id", "response_id"]),
        ...(payload.usage ? { usage: pick(payload.usage, SAFE_USAGE_KEYS) } : {}),
        ...(payload.turn_token_usage
          ? { turn_token_usage: pick(payload.turn_token_usage, SAFE_USAGE_KEYS) }
          : {}),
        ...(payload.thread_token_usage
          ? { thread_token_usage: pick(payload.thread_token_usage, SAFE_USAGE_KEYS) }
          : {}),
      };

    case "event_msg": {
      const subtype = payload.type;
      if (subtype === "task_started") {
        return {
          ...pick(payload, [
            "type",
            "turn_id",
            "root_turn_id",
            "started_at",
            "model_context_window",
            "collaboration_mode_kind",
          ]),
          ...(payload.turn_attribution
            ? {
                turn_attribution: pick(payload.turn_attribution, [
                  "turn_id",
                  "turn_trigger",
                  "parent_turn_id",
                  "initiating_agent_path",
                  "root_turn_id",
                ]),
              }
            : {}),
        };
      }
      if (subtype === "task_complete") {
        // Deliberately excludes last_agent_message — the model's final reply text.
        return pick(payload, [
          "type",
          "turn_id",
          "root_turn_id",
          "started_at",
          "completed_at",
          "duration_ms",
          "time_to_first_token_ms",
        ]);
      }
      if (subtype === "thread_settings_applied") {
        return {
          ...pick(payload, ["type", "thread_id"]),
          ...(payload.thread_settings
            ? {
                thread_settings: pick(payload.thread_settings, [
                  "model",
                  "model_provider_id",
                  "service_tier",
                ]),
              }
            : {}),
        };
      }
      // token_count, item_completed, and anything else: structure only.
      return pick(payload, ["type"]);
    }

    // response_item (message/reasoning/custom_tool_call/...) and world_state
    // carry nothing but prompt/code/tool content. Structure only.
    default:
      return typeof payload.type === "string" ? { type: payload.type } : {};
  }
}

function redact(record) {
  const out = pick(record, SAFE_TOP_LEVEL);
  out.payload = redactPayload(record.type, record.payload);
  return out;
}

const [, , source, dest] = process.argv;
if (!source || !dest) {
  console.error("usage: redact-codex-fixture.mjs <source.jsonl> <dest.jsonl>");
  process.exit(1);
}

const lines = readFileSync(source, "utf8").split("\n").filter(Boolean);
const redacted = lines.map((line) => JSON.stringify(redact(JSON.parse(line))));
writeFileSync(dest, redacted.join("\n") + "\n");

console.error(`${lines.length} records -> ${dest}`);
