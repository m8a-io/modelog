#!/usr/bin/env node
// Redacts a real Copilot debug log into a committable test fixture.
//
// This repo is public. Copilot's debug logs contain full prompts and code.
// So redaction here is an ALLOWLIST, never a denylist: every attr is dropped
// unless it is named below. A Copilot update that adds a new content-bearing
// field therefore leaks nothing — it is simply not copied. A denylist would
// have the opposite failure mode, which is the wrong way round for a file
// that gets pushed to GitHub.
//
//   node scripts/redact-copilot-fixture.mjs <source.jsonl> <dest.jsonl>
//
// Verify the result with test/copilot-fixture.test.ts, which re-asserts the
// allowlist against whatever is actually committed.

import { readFileSync, writeFileSync } from "node:fs";

/** Top-level record fields that carry no prompt or code content. */
const SAFE_TOP_LEVEL = ["v", "ts", "dur", "sid", "type", "name", "spanId", "parentSpanId", "status"];

/** Per-type attr allowlist. A type absent here keeps NO attrs at all. */
const SAFE_ATTRS = {
  session_start: ["copilotVersion", "vscodeVersion", "parentSessionId", "label"],
  turn_start: ["turnId"],
  turn_end: ["turnId"],
  child_session_ref: ["childSessionId", "childLogFile", "label"],
  llm_request: [
    "model",
    "debugName",
    "inputTokens",
    "outputTokens",
    "cachedTokens",
    "ttft",
    "responseId",
    "maxTokens",
    "temperature",
    "topP",
    "copilotUsageNanoAiu",
    "systemPromptFile",
    "toolsFile",
    "error",
  ],
  // user_message, agent_response, tool_call, discovery, generic: structure only.
};

function redact(record) {
  const out = {};
  for (const key of SAFE_TOP_LEVEL) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  const allowed = SAFE_ATTRS[record.type] ?? [];
  const attrs = {};
  for (const key of allowed) {
    if (record.attrs?.[key] !== undefined) attrs[key] = record.attrs[key];
  }
  // Keep the key present even when empty, so the record shape still reads as
  // a real one to the parser under test.
  out.attrs = attrs;
  return out;
}

const [, , source, dest] = process.argv;
if (!source || !dest) {
  console.error("usage: redact-copilot-fixture.mjs <source.jsonl> <dest.jsonl>");
  process.exit(1);
}

const lines = readFileSync(source, "utf8").split("\n").filter(Boolean);
const redacted = lines.map((line) => JSON.stringify(redact(JSON.parse(line))));
writeFileSync(dest, redacted.join("\n") + "\n");

console.error(`${lines.length} records -> ${dest}`);
