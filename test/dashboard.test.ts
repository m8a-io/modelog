import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelogService } from "../src/service.ts";

/**
 * The dashboard is per-source: one assistant at a time, in that assistant's
 * own unit. These drive the real service over a real store with both sources
 * on disk, because the thing worth testing is the whole path from two sets of
 * log files to two separate view models — not a hand-built state object.
 */

const FIXTURES = join(import.meta.dirname, "fixtures", "copilot");

function claudeRecord(over: { uuid: string; model: string; ts: string; session?: string }): string {
  return JSON.stringify({
    type: "assistant",
    uuid: over.uuid,
    sessionId: over.session ?? "s1",
    timestamp: over.ts,
    cwd: "/workspace/example",
    gitBranch: "main",
    entrypoint: "claude-vscode",
    message: {
      role: "assistant",
      model: over.model,
      usage: {
        input_tokens: 10,
        output_tokens: 100,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 0,
        iterations: [{ type: "message" }],
      },
    },
  });
}

/** A workspace tree holding the committed Copilot fixtures, laid out as VS Code does. */
function copilotTree(): string {
  const root = mkdtempSync(join(tmpdir(), "modelog-ws-"));
  const session = join(root, "hash1", "GitHub.copilot-chat", "debug-logs", "sess-1");
  mkdirSync(session, { recursive: true });
  copyFileSync(join(FIXTURES, "two-model-session.jsonl"), join(session, "main.jsonl"));
  copyFileSync(join(FIXTURES, "models-two-model-session.json"), join(session, "models.json"));
  return root;
}

function claudeTree(models: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "modelog-cc-"));
  const lines = models.map((model, i) =>
    claudeRecord({
      uuid: `u${i}`,
      model,
      // Spread across days so the chart has more than one column.
      ts: new Date(Date.UTC(2026, 8, 20 + (i % 3), 10)).toISOString(),
    }),
  );
  writeFileSync(join(root, "session.jsonl"), lines.join("\n") + "\n");
  return root;
}

async function serviceWith(opts: { claude?: string[]; copilot?: boolean }): Promise<ModelogService> {
  const svc = new ModelogService({
    storageDir: mkdtempSync(join(tmpdir(), "modelog-store-")),
    extensionDir: process.cwd(),
    logPaths: opts.claude ? [claudeTree(opts.claude)] : [],
    billingMode: "api",
    copilotLogPaths: opts.copilot ? [copilotTree()] : [],
  });
  await svc.init();
  svc.rescan();
  return svc;
}

test("a store with one source offers one source and needs no switcher", async () => {
  const svc = await serviceWith({ claude: ["claude-sonnet-5", "claude-opus-5"] });
  const state = svc.viewState(null);
  assert.equal(state.sources.length, 1);
  assert.equal(state.sources[0]!.id, "claude-code");
  assert.equal(state.activeSource, "claude-code");
  svc.dispose();
});

test("both sources appear, most-used first, with their own labels and counts", async () => {
  const svc = await serviceWith({ claude: ["claude-sonnet-5", "claude-opus-5"], copilot: true });
  const state = svc.viewState(null);
  assert.deepEqual(
    state.sources.map((s) => s.id),
    ["claude-code", "copilot"],
  );
  assert.equal(state.sources.find((s) => s.id === "copilot")!.label, "GitHub Copilot");
  assert.equal(state.sources.find((s) => s.id === "copilot")!.turns, 2);
  svc.dispose();
});

test("selecting a source switches the whole dashboard into that source's unit", async () => {
  const svc = await serviceWith({ claude: ["claude-sonnet-5"], copilot: true });

  const claude = svc.viewState(null, "claude-code");
  assert.equal(claude.activeSource, "claude-code");
  assert.match(claude.totals.total, /^\$|^<\$/);
  assert.match(claude.chart.costLabel, /\$/);

  const copilot = svc.viewState(null, "copilot");
  assert.equal(copilot.activeSource, "copilot");
  assert.match(copilot.totals.total, /credits$/);
  assert.match(copilot.chart.costLabel, /credits/);
  // Figures must not leak across: the Copilot view contains only Copilot models.
  assert.deepEqual(
    copilot.rows.map((r) => r.model).sort(),
    ["claude-sonnet-5", "gpt-5.6-terra"],
  );
  svc.dispose();
});

test("an unknown source falls back to the most-used rather than showing nothing", async () => {
  // Three Claude turns against the fixture's two Copilot turns, so "most-used"
  // has an unambiguous answer.
  const svc = await serviceWith({
    claude: ["claude-sonnet-5", "claude-sonnet-5", "claude-opus-5"],
    copilot: true,
  });
  const state = svc.viewState(null, "not-a-source");
  assert.equal(state.activeSource, "claude-code");
  svc.dispose();
});

test("billing copy follows the source being shown", async () => {
  const svc = await serviceWith({ claude: ["claude-sonnet-5"], copilot: true });
  assert.match(svc.viewState(null, "copilot").billing.detail, /not visible to Modelog/i);
  assert.doesNotMatch(svc.viewState(null, "claude-code").billing.detail, /credits consumed/i);
  svc.dispose();
});

// --- chart ------------------------------------------------------------------

test("the chart carries turns per model per day alongside cost", async () => {
  const svc = await serviceWith({ claude: ["claude-sonnet-5", "claude-opus-5", "claude-sonnet-5"] });
  const chart = svc.viewState(null).chart;
  assert.ok(chart.days.length > 1);
  for (const s of chart.series) {
    assert.equal(s.turns.length, chart.days.length, "turns are parallel to days");
    assert.equal(s.values.length, chart.days.length);
  }
  const totalTurns = chart.series.reduce((n, s) => n + s.turns.reduce((a, b) => a + b, 0), 0);
  assert.equal(totalTurns, 3);
  svc.dispose();
});

test("cost and turns have separate scales, so neither is drawn on the other's axis", async () => {
  const svc = await serviceWith({ claude: ["claude-sonnet-5", "claude-opus-5"] });
  const chart = svc.viewState(null).chart;
  assert.ok(chart.cost.max > 0);
  assert.ok(chart.turns.max > 0);
  assert.equal(chart.cost.ticks.length, 5);
  assert.equal(chart.turns.ticks.length, 5);
  // Turn ticks are counts, cost ticks are money — the labels prove they are
  // not the same scale wearing two hats.
  assert.match(chart.cost.ticks[4]!.label, /^\$|^<\$/);
  assert.match(chart.turns.ticks[4]!.label, /^\d+$/);
  svc.dispose();
});

test("chart values arrive scaled for display, since the webview computes nothing", async () => {
  const svc = await serviceWith({ claude: ["claude-sonnet-5"], copilot: true });
  const copilot = svc.viewState(null, "copilot").chart;
  const values = copilot.series.flatMap((s) => s.values).filter((v) => v !== null);
  assert.ok(values.length > 0);
  // Credits, not raw nano-AIU: a nano figure would be ~1e9 times larger.
  for (const v of values) assert.ok(v! < 1000, `${v} looks like an unscaled nano amount`);
  svc.dispose();
});

test("a model keeps its colour when the range changes the set of models shown", async () => {
  // Colour follows the model, not its rank in the current filter. Without
  // this, narrowing the range repaints every surviving model.
  const svc = await serviceWith({ claude: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"] });

  const all = svc.viewState(null).chart.series;
  const colorOf = (series: typeof all, model: string) =>
    series.find((s) => s.model === model)?.colorVar;

  const wide = colorOf(all, "claude-sonnet-5");
  assert.ok(wide);
  const narrow = svc.viewState(1).chart.series;
  if (colorOf(narrow, "claude-sonnet-5")) {
    assert.equal(colorOf(narrow, "claude-sonnet-5"), wide, "the model was repainted by a filter");
  }
  svc.dispose();
});

test("models past the palette fold into one Other bucket rather than repeating a hue", async () => {
  const many = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"];
  const svc = await serviceWith({ claude: many });
  const series = svc.viewState(null).chart.series;

  const colors = series.map((s) => s.colorVar);
  assert.equal(new Set(colors).size, colors.length, "two series shared a colour");

  const other = series.find((s) => s.model.startsWith("Other"));
  assert.ok(other, "expected an Other bucket past six models");
  assert.match(other!.model, /Other \(\d+ models\)/);
  // Folded turns are still counted — only identity is merged, not volume.
  const folded = other!.turns.reduce((a, b) => a + b, 0);
  assert.equal(folded, 2);
  // And it draws no cost line, because averaging cost across models is meaningless.
  assert.ok(other!.values.every((v) => v === null));
  svc.dispose();
});

test("the data the chart is built from never carries message content", async () => {
  const svc = await serviceWith({ claude: ["claude-sonnet-5"], copilot: true });
  const json = JSON.stringify(svc.viewState(null, "copilot"));
  const raw = readFileSync(join(FIXTURES, "two-model-session.jsonl"), "utf8");
  assert.ok(raw.length > 0);
  assert.doesNotMatch(json, /userRequest|inputMessages|agent_response/);
  svc.dispose();
});
