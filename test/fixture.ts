import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, loadSqlite } from "../src/store/sqliteStore.ts";
import type { Turn } from "../src/ingest/types.ts";

/**
 * A seeded read-only store for the MCP tool tests.
 *
 * Not named `*.test.ts`, so `node --test test/*.test.ts` does not run it as a
 * suite. The 2.3 query tools reuse this rather than each building their own,
 * so a change to what a realistic store contains lands in one place.
 *
 * The data deliberately contains every case the tools have to describe
 * honestly: a dated snapshot model id, subagent turns confined to one model,
 * an unknown model, and a known model carrying an unrecognised modifier. The
 * last two are separate causes of a null cost and must stay distinguishable.
 */

export const sqlite = await loadSqlite();

const DAY_MS = 86_400_000;
/** Fixed so every assertion is deterministic. */
export const BASE_TS = Date.parse("2026-09-01T09:00:00.000Z");

export function turn(p: Partial<Turn> & { uuid: string }): Turn {
  return {
    sessionId: "s1",
    ts: BASE_TS,
    model: "claude-sonnet-5",
    inputTokens: 100,
    cacheReadTokens: 10_000,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 500,
    thinkingTokens: 0,
    iterations: 1,
    entrypoint: "claude-vscode",
    isSidechain: false,
    captureVersion: 2,
    speed: null,
    inferenceGeo: null,
    source: "claude-code",
    costNanoAiu: null,
    tokenBreakdown: "reported",
    cwd: "/home/dev/project",
    gitBranch: "main",
    sourceFile: "/logs/s1.jsonl",
    ...p,
  };
}

/**
 * Nine turns across three sessions.
 *
 * Haiku appears only as subagent traffic, which mirrors what real Claude Code
 * data looks like and is the case `get_definitions` exists to make visible: an
 * agent reading per-model turn counts would otherwise conclude the developer
 * chose Haiku for work.
 */
export const FIXTURE_TURNS: Turn[] = [
  // Session 1 — main-conversation Sonnet, plus the Haiku subagents it spawned.
  turn({ uuid: "t1", sessionId: "s1", ts: BASE_TS }),
  turn({ uuid: "t2", sessionId: "s1", ts: BASE_TS + 60_000 }),
  turn({ uuid: "t3", sessionId: "s1", ts: BASE_TS + 120_000, iterations: 3 }),
  turn({
    uuid: "t4",
    sessionId: "s1",
    ts: BASE_TS + 30_000,
    // A dated snapshot id: must price at the bare id's rates.
    model: "claude-haiku-4-5-20251001",
    isSidechain: true,
  }),
  turn({
    uuid: "t5",
    sessionId: "s1",
    ts: BASE_TS + 90_000,
    model: "claude-haiku-4-5-20251001",
    isSidechain: true,
  }),

  // Session 2 — Opus the next day, one turn in fast mode, on a feature branch.
  turn({
    uuid: "t6",
    sessionId: "s2",
    ts: BASE_TS + DAY_MS,
    model: "claude-opus-5",
    gitBranch: "feature/pricing",
    sourceFile: "/logs/s2.jsonl",
  }),
  turn({
    uuid: "t7",
    sessionId: "s2",
    ts: BASE_TS + DAY_MS + 60_000,
    model: "claude-opus-5",
    speed: "fast",
    gitBranch: "feature/pricing",
    sourceFile: "/logs/s2.jsonl",
  }),
  // Cause 1 of a null cost: a model the rate table has never heard of.
  turn({
    uuid: "t8",
    sessionId: "s2",
    ts: BASE_TS + DAY_MS + 120_000,
    model: "claude-nonexistent-9",
    gitBranch: "feature/pricing",
    sourceFile: "/logs/s2.jsonl",
  }),

  // Session 3 — cause 2 of a null cost: a known model, an unrecognised
  // modifier. Pricing this at standard rates would report a known model at
  // the wrong cost, which is the more dangerous of the two failures.
  turn({
    uuid: "t9",
    sessionId: "s3",
    ts: BASE_TS + 2 * DAY_MS,
    model: "claude-opus-5",
    speed: "turbo",
    entrypoint: "claude-cli",
    sourceFile: "/logs/s3.jsonl",
  }),
];

export interface Fixture {
  path: string;
  cleanup(): void;
}

/** Write `turns` to a real SQLite file and close it, leaving it for a reader. */
export function makeStore(turns: readonly Turn[] = FIXTURE_TURNS): Fixture {
  if (!sqlite) throw new Error("node:sqlite unavailable; guard the test with { skip: !sqlite }");

  const dir = mkdtempSync(join(tmpdir(), "modelog-fixture-"));
  const path = join(dir, "modelog.db");
  const store = new SqliteStore(sqlite, path);
  if (turns.length > 0) store.upsertTurns(turns);
  store.close();

  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A valid, current, empty store — distinct from an absent one. */
export function makeEmptyStore(): Fixture {
  return makeStore([]);
}
