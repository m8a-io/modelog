import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCopilotChunk,
  findCopilotLogs,
  solveCacheWrite,
  copilotAdapter,
} from "../src/ingest/copilot.ts";
import { parseCard, loadCard } from "../src/ingest/copilotCard.ts";

const DIR = join(import.meta.dirname, "fixtures", "copilot");

function fixture(name: string): string {
  return readFileSync(join(DIR, name), "utf8");
}

function card(name: string) {
  return parseCard(JSON.parse(fixture(name)));
}

const TWO_MODEL = () => fixture("two-model-session.jsonl");
const TWO_MODEL_CARD = () => card("models-two-model-session.json");
const BACKGROUND = () => fixture("subagent-and-background.jsonl");
const BACKGROUND_CARD = () => card("models-subagent-and-background.json");
const SUBAGENT = () => fixture("subagent-child.jsonl");

// --- the turn/iteration distinction (PRD §7.1 Correction 2) ------------------

test("requests sharing a user message are ONE turn, not one turn each", () => {
  // The real session has 2 user messages and 8 llm_requests. Reading Copilot's
  // own "turn_start" spans as turns would report 8.
  const { turns } = parseCopilotChunk(TWO_MODEL(), "main.jsonl", TWO_MODEL_CARD());
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((t) => t.iterations), [3, 5]);
});

test("a model switch between user messages produces one turn per model", () => {
  const { turns } = parseCopilotChunk(TWO_MODEL(), "main.jsonl", TWO_MODEL_CARD());
  assert.deepEqual(turns.map((t) => t.model), ["gpt-5.6-terra", "claude-sonnet-5"]);
});

test("a turn's uuid is stable across re-reads, since whole-file adapters re-ingest", () => {
  const a = parseCopilotChunk(TWO_MODEL(), "main.jsonl", TWO_MODEL_CARD()).turns;
  const b = parseCopilotChunk(TWO_MODEL(), "main.jsonl", TWO_MODEL_CARD()).turns;
  assert.deepEqual(a.map((t) => t.uuid), b.map((t) => t.uuid));
  // responseId is NOT usable for this: two requests in one real log share one.
  assert.match(a[0]!.uuid, /^ab8d6457-900e-4ea2-a5e5-50905e74ab73:/);
});

// --- the cache-write solve (PRD §7.1 Correction 4) ---------------------------

test("cache writes are solved exactly from the billing equation", () => {
  // Measured from the real session: request 1 is 23,626 input tokens of which
  // 23,623 are a cache write, and the solve recovers it to the token.
  const prices = TWO_MODEL_CARD().get("gpt-5.6-terra")!;
  const write = solveCacheWrite(
    { inputTokens: 23626, cachedTokens: 0, outputTokens: 221, costNanoAiu: 6_171_550_000 },
    prices,
  );
  assert.equal(write, 23623);
});

test("the solve agrees with the successor-delta method wherever both are defined", () => {
  // The delta method (next request's cachedTokens minus this one's) is what
  // the PRD originally specified. Agreement on every row where it applies is
  // the evidence the closed form is the same quantity, not a coincidence.
  const prices = TWO_MODEL_CARD().get("claude-sonnet-5")!;
  const requests = [
    { inputTokens: 33250, cachedTokens: 13324, outputTokens: 277, costNanoAiu: 5_524_930_000 },
    { inputTokens: 33589, cachedTokens: 33249, outputTokens: 264, costNanoAiu: 1_013_880_000 },
    { inputTokens: 33887, cachedTokens: 33587, outputTokens: 277, costNanoAiu: 1_023_640_000 },
  ];
  for (let i = 0; i < requests.length - 1; i++) {
    const delta = requests[i + 1]!.cachedTokens - requests[i]!.cachedTokens;
    assert.equal(solveCacheWrite(requests[i]!, prices), delta);
  }
});

test("the solve resolves the last request of a turn, which the delta method cannot", () => {
  const prices = TWO_MODEL_CARD().get("claude-sonnet-5")!;
  // Final request of the second turn: no successor exists to diff against.
  const write = solveCacheWrite(
    { inputTokens: 35113, cachedTokens: 34615, outputTokens: 407, costNanoAiu: 1_223_700_000 },
    prices,
  );
  assert.equal(write, 496);
});

test("a model priced at zero throughout is unsolvable, and says so rather than reporting zero", () => {
  // gpt-4o-mini's card prices are all 0, so wp - ip == 0 and the equation is
  // degenerate. Its requests also genuinely cost 0 — so the cost is known and
  // only the token split is not.
  const prices = BACKGROUND_CARD().get("gpt-4o-mini-2024-07-18")!;
  assert.equal(prices.input, 0);
  assert.equal(
    solveCacheWrite({ inputTokens: 1669, cachedTokens: 0, outputTokens: 71, costNanoAiu: 0 }, prices),
    null,
  );
});

test("an unsolvable turn is marked unknown, keeps its measured cost, and is not silently zeroed", () => {
  const { turns } = parseCopilotChunk(BACKGROUND(), "main.jsonl", BACKGROUND_CARD());
  const mini = turns.filter((t) => t.model === "gpt-4o-mini-2024-07-18");
  assert.ok(mini.length > 0);
  for (const t of mini) {
    assert.equal(t.tokenBreakdown, "unknown");
    assert.equal(t.cacheWrite5mTokens, 0, "not a claim of zero — tokenBreakdown says it is unknown");
    assert.equal(t.costNanoAiu, 0, "the cost is measured and remains known");
  }
});

test("a request with no measured cost cannot be solved", () => {
  const prices = TWO_MODEL_CARD().get("claude-sonnet-5")!;
  assert.equal(
    solveCacheWrite({ inputTokens: 100, cachedTokens: 0, outputTokens: 10, costNanoAiu: null }, prices),
    null,
  );
});

test("solved token classes add back up to what the source reported", () => {
  const { turns } = parseCopilotChunk(TWO_MODEL(), "main.jsonl", TWO_MODEL_CARD());
  const first = turns[0]!;
  assert.equal(first.tokenBreakdown, "solved");
  // 23626 + 23947 + 24629 input tokens across the turn's three requests.
  const total =
    first.inputTokens + first.cacheReadTokens + first.cacheWrite5mTokens;
  assert.equal(total, 23626 + 23947 + 24629);
});

// --- cost (measured, not derived) -------------------------------------------

test("a turn's cost is the sum of what Copilot measured for its requests", () => {
  const { turns } = parseCopilotChunk(TWO_MODEL(), "main.jsonl", TWO_MODEL_CARD());
  assert.equal(turns[0]!.costNanoAiu, 6_171_550_000 + 751_310_000 + 750_780_000);
  assert.equal(turns[0]!.source, "copilot");
});

// --- subagents are a file, not a span (PRD §7.1 Correction 3) ----------------

test("a subagent child log is flagged as sidechain traffic", () => {
  const { turns } = parseCopilotChunk(SUBAGENT(), "executionSubagent-toolu_x.jsonl", new Map());
  assert.ok(turns.length > 0);
  for (const t of turns) assert.equal(t.isSidechain, true);
});

test("the main log is not sidechain traffic", () => {
  const { turns } = parseCopilotChunk(TWO_MODEL(), "main.jsonl", TWO_MODEL_CARD());
  for (const t of turns) assert.equal(t.isSidechain, false);
});

test("background agent traffic is an entrypoint, not a subagent", () => {
  // backgroundTodoAgent is work the developer did not initiate, but it is not
  // a spawned subagent either — conflating the two would hide one or the other.
  const { turns } = parseCopilotChunk(BACKGROUND(), "main.jsonl", BACKGROUND_CARD());
  const background = turns.filter((t) => t.entrypoint === "backgroundTodoAgent");
  assert.ok(background.length > 0);
  for (const t of background) assert.equal(t.isSidechain, false);
});

// --- gaps are gaps (PRD §8.2) ------------------------------------------------

test("fields this source does not carry are null, not invented", () => {
  const { turns } = parseCopilotChunk(TWO_MODEL(), "main.jsonl", TWO_MODEL_CARD());
  for (const t of turns) {
    assert.equal(t.cwd, null, "the workspace hash is not reversible into a path");
    assert.equal(t.gitBranch, null);
    assert.equal(t.speed, null);
    assert.equal(t.inferenceGeo, null);
  }
});

test("an empty or header-only log yields no turns and no error", () => {
  const onlyStart = '{"ts":1,"sid":"s","type":"session_start","attrs":{}}\n';
  assert.deepEqual(parseCopilotChunk(onlyStart, "main.jsonl", new Map()).turns, []);
  assert.deepEqual(parseCopilotChunk("", "main.jsonl", new Map()).turns, []);
});

test("a corrupt line is reported and the rest of the file still parses", () => {
  const text = TWO_MODEL().split("\n").filter(Boolean);
  text.splice(3, 0, '{"type":"llm_request", BROKEN');
  const res = parseCopilotChunk(text.join("\n") + "\n", "main.jsonl", TWO_MODEL_CARD());
  assert.equal(res.diagnostics.filter((d) => d.kind === "parse-error").length, 1);
  assert.equal(res.turns.length, 2, "the good records still produce their turns");
});

test("a half-written trailing line is dropped rather than parsed", () => {
  const partial = TWO_MODEL() + '{"type":"llm_request","attrs":{"mod';
  const res = parseCopilotChunk(partial, "main.jsonl", TWO_MODEL_CARD());
  assert.equal(res.turns.length, 2);
  assert.equal(res.diagnostics.filter((d) => d.kind === "parse-error").length, 0);
  // Whole-file adapters re-read from zero, so nothing is carried forward.
  assert.equal(res.remainder, "");
});

test("the 5-minute cache tier is an assumption, and is declared as one", () => {
  const { diagnostics } = parseCopilotChunk(TWO_MODEL(), "main.jsonl", TWO_MODEL_CARD());
  assert.ok(diagnostics.some((d) => d.kind === "assumed-cache-ttl"));
});

// --- invariant 1: no prompt or code content ever reaches a Turn --------------

test("no parsed turn carries any value sourced from prompt or code content", () => {
  const { turns } = parseCopilotChunk(TWO_MODEL(), "main.jsonl", TWO_MODEL_CARD());
  // Everything a Turn holds must be a number, a null, a known enum, or an
  // identifier — never free text from the conversation.
  for (const t of turns) {
    for (const [key, value] of Object.entries(t)) {
      if (typeof value !== "string") continue;
      const allowed = ["uuid", "sessionId", "model", "source", "entrypoint", "tokenBreakdown", "sourceFile"];
      assert.ok(allowed.includes(key), `unexpected string field "${key}" on a Turn`);
    }
  }
});

// --- discovery is path-shaped, not extension-shaped --------------------------

function workspaceTree(): string {
  const root = mkdtempSync(join(tmpdir(), "modelog-copilot-"));
  const session = join(root, "abc123", "GitHub.copilot-chat", "debug-logs", "sess-1");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "main.jsonl"), "");
  writeFileSync(join(session, "executionSubagent-toolu_1.jsonl"), "");
  writeFileSync(join(session, "models.json"), "[]");
  writeFileSync(join(session, "system_prompt_0.json"), "{}");
  // The content file that an extension-based walk would wrongly ingest.
  const transcripts = join(root, "abc123", "GitHub.copilot-chat", "transcripts");
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(join(transcripts, "sess-1.jsonl"), "");
  return root;
}

test("discovery finds the session log and its subagent children", () => {
  const found = findCopilotLogs(workspaceTree()).map((p) => p.split("/").pop());
  assert.deepEqual(found.sort(), ["executionSubagent-toolu_1.jsonl", "main.jsonl"]);
});

test("discovery never returns transcripts, which are pure conversation content", () => {
  for (const p of findCopilotLogs(workspaceTree())) {
    assert.doesNotMatch(p, /transcripts/);
    assert.doesNotMatch(p, /system_prompt/);
  }
});

test("a root with no Copilot data yields nothing rather than throwing", () => {
  assert.deepEqual(findCopilotLogs(join(tmpdir(), "does-not-exist-at-all")), []);
  assert.deepEqual(findCopilotLogs(mkdtempSync(join(tmpdir(), "modelog-empty-"))), []);
});

// --- the no-folder shape: globalStorage, lowercase, no hash level ------------

/**
 * A folder-less Copilot session — the Extension Development Host's own
 * default state (CLAUDE.md) — writes here instead of under a workspace hash.
 * Lowercase and one level shallower than the workspace-bound shape: a prior
 * version of `findCopilotLogs` that only walked the hash shape missed every
 * session here, silently, including a real one caught live on this machine.
 */
function globalStorageTree(): string {
  const root = mkdtempSync(join(tmpdir(), "modelog-copilot-global-"));
  const session = join(root, "github.copilot-chat", "debug-logs", "sess-2");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "main.jsonl"), "");
  writeFileSync(join(session, "models.json"), "[]");
  return root;
}

test("a no-folder session under globalStorage is found too", () => {
  const found = findCopilotLogs(globalStorageTree()).map((p) => p.split("/").pop());
  assert.deepEqual(found, ["main.jsonl"]);
});

test("both shapes are found from the same root without one shadowing the other", () => {
  const root = mkdtempSync(join(tmpdir(), "modelog-copilot-both-"));
  const workspaceSession = join(root, "abc123", "GitHub.copilot-chat", "debug-logs", "sess-1");
  mkdirSync(workspaceSession, { recursive: true });
  writeFileSync(join(workspaceSession, "main.jsonl"), "");
  const globalSession = join(root, "github.copilot-chat", "debug-logs", "sess-2");
  mkdirSync(globalSession, { recursive: true });
  writeFileSync(join(globalSession, "main.jsonl"), "");

  const found = findCopilotLogs(root);
  assert.equal(found.length, 2);
  assert.ok(found.some((p) => p.includes("sess-1")));
  assert.ok(found.some((p) => p.includes("sess-2")));
});

test("the adapter re-reads whole files, because a turn spans many lines", () => {
  assert.equal(copilotAdapter.source, "copilot");
  assert.equal(copilotAdapter.mode, "whole-file");
});

// --- rate card ---------------------------------------------------------------

test("card prices are scaled to integer nano-AIU per token", () => {
  const c = TWO_MODEL_CARD();
  const sonnet = c.get("claude-sonnet-5")!;
  // 200 credits per 1M tokens -> 200,000 nano-AIU per token.
  assert.equal(sonnet.input, 200_000);
  assert.equal(sonnet.cacheWrite, 250_000);
  assert.equal(sonnet.cacheRead, 20_000);
  assert.equal(sonnet.output, 1_000_000);
});

test("a fractional card price that still scales to an integer is accepted", () => {
  // 7.5 credits/1M is real (gemini-3.8-flash) and scales to 7,500 exactly.
  const c = parseCard([
    { id: "m", billing: { token_prices: { default: { input_price: 7.5, output_price: 1, cache_read_price: 1, cache_write_price: 2 } } } },
  ]);
  assert.equal(c.get("m")!.input, 7500);
});

test("a card price too precise to scale is omitted rather than rounded", () => {
  const c = parseCard([
    { id: "m", billing: { token_prices: { default: { input_price: 0.00001234, output_price: 1, cache_read_price: 1, cache_write_price: 2 } } } },
  ]);
  assert.equal(c.get("m"), undefined, "rounding would silently shift every solve using it");
});

test("a missing card file yields an empty card rather than throwing", () => {
  assert.equal(loadCard(join(tmpdir(), "nope-not-here")).size, 0);
});

test("a turn whose model is absent from the card is unknown, not unpriced-as-zero", () => {
  const { turns } = parseCopilotChunk(TWO_MODEL(), "main.jsonl", new Map());
  for (const t of turns) {
    assert.equal(t.tokenBreakdown, "unknown");
    assert.ok(t.costNanoAiu! > 0, "cost is measured and survives a missing card");
  }
});

// --- background traffic shares a user message with the developer's own work --

test("background agent requests do not merge into the developer's turn", () => {
  // Measured on a real session: backgroundTodoAgent issues requests under the
  // SAME user_message span as panel/editAgent. Grouping on the parent span
  // alone merged them, blended two models into one turn, and (because the
  // group then looked model-mixed) discarded 50 of 69 real requests.
  const { turns } = parseCopilotChunk(BACKGROUND(), "main.jsonl", BACKGROUND_CARD());

  const dev = turns.filter((t) => t.entrypoint === "panel/editAgent");
  const background = turns.filter((t) => t.entrypoint === "backgroundTodoAgent");
  assert.equal(dev.length, 1);
  assert.equal(background.length, 2);

  // Every request is accounted for; none is dropped as "mixed model".
  assert.equal(turns.reduce((n, t) => n + t.iterations, 0), 6);
  for (const t of turns) assert.equal(new Set([t.model]).size, 1);
});

test("a turn's surface is a single value, not a blend", () => {
  const { turns } = parseCopilotChunk(BACKGROUND(), "main.jsonl", BACKGROUND_CARD());
  for (const t of turns) {
    assert.ok(t.entrypoint === "panel/editAgent" || t.entrypoint === "backgroundTodoAgent");
  }
});

test("turns from the same user message but different surfaces get distinct uuids", () => {
  const { turns } = parseCopilotChunk(BACKGROUND(), "main.jsonl", BACKGROUND_CARD());
  assert.equal(new Set(turns.map((t) => t.uuid)).size, turns.length);
});
