#!/usr/bin/env node
/**
 * Generates a week of plausible-looking Claude Code and Copilot session data
 * for recording demo GIFs — NOT shipped (scripts/ is in .vscodeignore), and
 * NOT a fixture: this is fabricated for a screen recording, not a test.
 *
 * Costs are never hand-picked. Token counts are generated; the real pricing
 * table (data/pricing.json) and the real Copilot rate-card math compute cost
 * from them, the same way the extension itself would. That's the one honesty
 * rule this script keeps from the product it's demonstrating.
 *
 * Writes into ~/modelog-demo/, which is also a ready-to-open VS Code
 * workspace: its .vscode/settings.json points modelog.logPaths and
 * modelog.copilotLogPaths at the fake data only, so a real ~/.claude or real
 * Copilot logs are never touched or mixed in.
 *
 * Usage: node scripts/generate-demo-data.mjs
 */
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const ROOT = join(homedir(), "modelog-demo");
// Deliberately not named "fake-*"/"demo-*": these paths exist on disk and
// nothing stops an agent from noticing a suspicious name even though no
// current MCP tool actually surfaces a turn's source file.
const CLAUDE_ROOT = join(ROOT, "logs", "claude-projects");
const COPILOT_ROOT = join(ROOT, "logs", "copilot-storage");

// Deterministic so re-runs (retakes) produce the same-looking week.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261008);
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (arr) => arr[int(0, arr.length - 1)];

const DAYS = 7;
const today = new Date();
today.setHours(0, 0, 0, 0);

// --- Claude Code --------------------------------------------------------

// Real model ids from data/pricing.json, so every turn prices normally.
const CC_MODELS = ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"];

function claudeRecord({ uuid, sessionId, model, ts, entrypoint, cwd, gitBranch }) {
  const input = int(50, 200);
  const cacheRead = int(3_500, 20_000);
  const hasCacheWrite = rand() < 0.4;
  const cacheCreate = hasCacheWrite ? int(3_000, 14_000) : 0;
  const output = int(700, 3_000);
  return JSON.stringify({
    type: "assistant",
    uuid,
    sessionId,
    timestamp: new Date(ts).toISOString(),
    cwd,
    gitBranch,
    entrypoint,
    message: {
      role: "assistant",
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
        cache_creation: hasCacheWrite
          ? { ephemeral_5m_input_tokens: cacheCreate, ephemeral_1h_input_tokens: 0 }
          : undefined,
        iterations: [{ type: "message" }],
      },
    },
  });
}

function generateClaudeCode() {
  const lines = [];
  const sessionId = randomUUID();
  // The real workspace path, not a fabricated one: `list_sessions` sends
  // `cwds` straight to the agent over MCP, so a made-up path here is a
  // direct, machine-readable tell that the data isn't real — far more than
  // anything a human would notice by eye. This one is simply true: it's
  // where the recording actually happens.
  const cwd = ROOT;
  const gitBranch = "main";

  for (let d = 0; d < DAYS; d++) {
    // Ends yesterday, not today: a day anchored on "today" can land in the
    // future relative to the actual clock depending what time it's run.
    const dayStart = today.getTime() - (DAYS - d) * 86_400_000 + 9 * 3_600_000; // 09:00 local
    // 1-2 model switches a day => 2-3 blocks.
    const blockCount = int(2, 3);
    const blocks = Array.from({ length: blockCount }, () => pick(CC_MODELS));
    // Avoid two identical back-to-back blocks so every block is a real switch.
    for (let i = 1; i < blocks.length; i++) {
      while (blocks[i] === blocks[i - 1]) blocks[i] = pick(CC_MODELS);
    }

    // Drawn from a narrow band within 100-400, not two compounded random
    // ranges — that's what produced wildly uneven days before: block count
    // and per-block size varying independently can still average out fine
    // and still let one day's draws stack higher than another's by a lot.
    let remaining = int(180, 260);
    let cursor = dayStart;
    blocks.forEach((model, bi) => {
      const isLast = bi === blocks.length - 1;
      const turnsInBlock = isLast
        ? remaining
        : Math.min(remaining - (blocks.length - bi - 1), Math.round(remaining / (blocks.length - bi)));
      remaining -= turnsInBlock;
      for (let t = 0; t < turnsInBlock; t++) {
        cursor += int(30, 300) * 1000; // 0.5-5 minutes between turns
        lines.push(
          claudeRecord({
            uuid: randomUUID(),
            sessionId,
            model,
            ts: cursor,
            entrypoint: "cli",
            cwd,
            gitBranch,
          }),
        );
      }
      cursor += int(5, 20) * 60_000; // gap before the next model block
    });
  }

  const dir = join(CLAUDE_ROOT, "project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
  return lines.length;
}

// --- Copilot -------------------------------------------------------------

// A rate card shaped like the real `models.json` Copilot writes beside each
// session (credits per 1M tokens) — see src/ingest/copilotCard.ts.
const COPILOT_CARD = {
  "claude-sonnet-5": { input: 200, output: 1000, cacheRead: 20, cacheWrite: 250 },
  "gpt-6-luna": { input: 100, output: 500, cacheRead: 10, cacheWrite: 125 },
};
const COPILOT_MODELS = Object.keys(COPILOT_CARD);

function modelsJsonFixture() {
  return JSON.stringify(
    Object.entries(COPILOT_CARD).map(([id, p]) => ({
      id,
      billing: {
        token_prices: {
          default: {
            input_price: p.input,
            output_price: p.output,
            cache_read_price: p.cacheRead,
            cache_write_price: p.cacheWrite,
          },
        },
      },
    })),
  );
}

// nano-AIU/token, matching the scaling copilotCard.ts does (credits/1M * 1000).
const NANO_PER_CREDIT_PER_1M = 1000;

function copilotRequest({ parentSpanId, ts, model, debugName, sid }) {
  const p = COPILOT_CARD[model];
  const cacheRead = int(4_000, 25_000);
  const plain = int(20, 200);
  const write = rand() < 0.4 ? int(1_000, 8_000) : 0;
  const output = int(150, 1_000);

  const ip = p.input * NANO_PER_CREDIT_PER_1M;
  const op = p.output * NANO_PER_CREDIT_PER_1M;
  const rp = p.cacheRead * NANO_PER_CREDIT_PER_1M;
  const wp = p.cacheWrite * NANO_PER_CREDIT_PER_1M;
  const cost = plain * ip + write * wp + cacheRead * rp + output * op;

  return JSON.stringify({
    ts,
    // A real UUID, matching Copilot's own session-id shape — this becomes
    // the Turn's sessionId and is exposed to the agent via list_sessions,
    // so a literal word like "demo-session" here would be as much of a
    // giveaway as the fabricated cwd was.
    sid,
    type: "llm_request",
    spanId: randomUUID(),
    parentSpanId,
    attrs: {
      model,
      debugName,
      inputTokens: plain + write + cacheRead,
      outputTokens: output,
      cachedTokens: cacheRead,
      copilotUsageNanoAiu: cost,
    },
  });
}

function generateCopilot() {
  const lines = [];
  const sessionId = randomUUID();

  for (let d = 0; d < DAYS; d++) {
    const dayStart = today.getTime() - (DAYS - d) * 86_400_000 + 10 * 3_600_000; // 10:00 local
    const blockCount = int(1, 2); // Copilot sees lighter use than Claude Code in this demo.
    const blocks = Array.from({ length: blockCount }, () => pick(COPILOT_MODELS));
    for (let i = 1; i < blocks.length; i++) {
      while (blocks[i] === blocks[i - 1]) blocks[i] = pick(COPILOT_MODELS);
    }

    let cursor = dayStart;
    for (const model of blocks) {
      // Each "user_message" (parentSpanId) groups 1-4 llm_requests into one Turn.
      const messageCount = int(3, 6);
      for (let m = 0; m < messageCount; m++) {
        const parentSpanId = randomUUID();
        const requestCount = int(1, 3);
        for (let r = 0; r < requestCount; r++) {
          cursor += int(60, 300) * 1000;
          lines.push(
            copilotRequest({ parentSpanId, ts: cursor, model, debugName: "panel/editAgent", sid: sessionId }),
          );
        }
      }
      cursor += int(10, 40) * 60_000;
    }
  }

  const dir = join(COPILOT_ROOT, "github.copilot-chat", "debug-logs", sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.jsonl"), lines.join("\n") + "\n");
  writeFileSync(join(dir, "models.json"), modelsJsonFixture());
  return lines.length;
}

// --- workspace scaffolding -------------------------------------------------

function writeWorkspaceSettings() {
  const vscodeDir = join(ROOT, ".vscode");
  mkdirSync(vscodeDir, { recursive: true });
  writeFileSync(
    join(vscodeDir, "settings.json"),
    JSON.stringify(
      {
        "modelog.logPaths": [CLAUDE_ROOT],
        "modelog.copilotLogPaths": [COPILOT_ROOT],
        "modelog.copilot.enabled": "auto",
        "modelog.billingMode": "api",
      },
      null,
      2,
    ) + "\n",
  );
  // Deliberately no README (or any other prose file) written into the
  // workspace. An agent asked a question here reads whatever's actually in
  // the folder as context, and a file that says "fake data for demo GIFs"
  // is a direct, textual reason for it to hedge its answer. The usage
  // instructions live in this script's own output instead.
}

/**
 * Deletes Modelog's own persistent store (not the fake log files — the
 * SQLite cache those files get ingested into).
 *
 * Rewriting fake-logs/ with fresh random uuids each run doesn't remove last
 * run's turns from the store: `upsertTurns` only ever inserts-or-replaces by
 * uuid, and a rescan has no way to know a vanished file's turns should go
 * too (by design — real usage must never be forgotten just because a log
 * rotated). For churny demo data that means every regeneration silently
 * stacks on the last one. Deleting the db file is safe regardless: it's a
 * pure rebuild cache, never the source of truth, so the next rescan just
 * rebuilds it from whatever log files exist at that moment — the same
 * recovery path a schema migration already relies on.
 *
 * Best-effort across the common VS Code data roots; only deletes the db
 * file itself; the extension's own globalStorage directory (MCP bundle,
 * etc.) is left alone.
 */
function clearModelogStore() {
  const candidates = [
    join(homedir(), ".vscode-server", "data", "User", "globalStorage", "modelog.modelog"),
    join(homedir(), ".config", "Code", "User", "globalStorage", "modelog.modelog"),
    join(homedir(), ".config", "Code - Insiders", "User", "globalStorage", "modelog.modelog"),
    join(homedir(), "Library", "Application Support", "Code", "User", "globalStorage", "modelog.modelog"),
    join(homedir(), "AppData", "Roaming", "Code", "User", "globalStorage", "modelog.modelog"),
  ];
  let cleared = 0;
  for (const dir of candidates) {
    for (const suffix of ["modelog.db", "modelog.db-wal", "modelog.db-shm"]) {
      const f = join(dir, suffix);
      if (existsSync(f)) {
        rmSync(f, { force: true });
        cleared++;
      }
    }
  }
  return cleared;
}

// --- run ---------------------------------------------------------------

rmSync(join(ROOT, "logs"), { recursive: true, force: true });
// Transitional: an earlier version of this script used "fake-logs" as the
// directory name, which is exactly the kind of giveaway this rename fixed.
rmSync(join(ROOT, "fake-logs"), { recursive: true, force: true });
// Leftover from an older version of this script that did write a README
// into the workspace — removed so a stale "fake data" file can't linger.
rmSync(join(ROOT, "README.md"), { force: true });
const dbFilesCleared = clearModelogStore();
const ccTurns = generateClaudeCode();
const copilotRequests = generateCopilot();
writeWorkspaceSettings();

console.log(`Cleared ${dbFilesCleared} old store file(s)`);
console.log(`Wrote ${ccTurns} Claude Code turns to ${CLAUDE_ROOT}`);
console.log(`Wrote ${copilotRequests} Copilot llm_requests to ${COPILOT_ROOT}`);
console.log(`Workspace ready at ${ROOT}.`);
console.log(`Open that folder in VS Code and run "Modelog: Open Dashboard", or chat there with Modelog's MCP server enabled.`);
console.log(`Reload the window (or reopen the folder) first if it was already open, so the clean store takes effect.`);
