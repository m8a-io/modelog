import type { TurnSource } from "../ingest/adapter.ts";
import type { FieldProvenance } from "../markers/vocabulary.ts";
import type { WorkRecord } from "./records.ts";

/**
 * The Dashboard's Work sessions tab (PRD §7.25, W8, W10). Pure: built from the
 * records alone, so it needs neither the store's turns nor the read-time chat
 * link. Measured figures per work session (cost, active time, context peaks)
 * are a later release; nothing here estimates them.
 */

/** An open work session with no record for this long is shown as lost (W7, W8). */
export const LOST_AFTER_MS = 2 * 86_400_000;

export type WorkSessionStatus = "open" | "lost" | "done";

export interface WorkSessionRow {
  id: string;
  status: WorkSessionStatus;
  /** e.g. "Started 11/09/2026, 4:35 PM". */
  started: string;
  startedImplicitly: boolean;
  /** "Claude Code", or "Tool not observed" where the server could not tell. */
  tool: string;
  /** One for the first chat, plus one per continued handoff. */
  chats: number;
  handoffs: number;
  /** "8/10", done only. */
  rating: string | null;
  /**
   * Done: first record to closure, e.g. "2 d 3 h elapsed". Open or lost: time
   * since the last record. Elapsed includes every pause; active time needs the
   * measured turns and is not shown.
   */
  timing: string;
  /** Done only: the closure came more than LOST_AFTER_MS after the record before it (W8). */
  closedLate: boolean;
  summary: string | null;
  /** Done: the closure's open items. Open or lost: the latest handoff's. */
  openItems: readonly string[];
  openItemsHeading: string | null;
  /** e.g. "summary, open items drafted by the agent". */
  provenanceNote: string | null;
}

const SOURCE_LABELS: Record<TurnSource, string> = {
  "claude-code": "Claude Code",
  copilot: "GitHub Copilot",
  codex: "Codex",
};

export function formatDuration(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d} d` : `${d} d ${h % 24} h`;
}

function provenanceNote(fields: Array<[string, FieldProvenance | null]>): string | null {
  const drafted = fields.filter(([, p]) => p === "generated").map(([f]) => f);
  return drafted.length === 0 ? null : `${drafted.join(", ")} drafted by the agent`;
}

/** Every work session, newest first. Records arrive in append order. */
export function workSessionRows(
  records: readonly WorkRecord[],
  now: number,
  formatWhen: (ts: number) => string = (ts) => new Date(ts).toLocaleString(),
): WorkSessionRow[] {
  const groups = new Map<string, WorkRecord[]>();
  for (const r of records) {
    const g = groups.get(r.workSessionId);
    if (g) g.push(r);
    else groups.set(r.workSessionId, [r]);
  }

  const rows: Array<{ startedAt: number; row: WorkSessionRow }> = [];
  for (const [id, list] of groups) {
    const mine = [...list].sort((a, b) => a.attestedAt - b.attestedAt);
    const first = mine[0]!;
    const last = mine[mine.length - 1]!;
    const done = mine.find((r) => r.kind === "done") ?? null;
    const handoffs = mine.filter((r) => r.kind === "handoff");
    const lastHandoff = handoffs[handoffs.length - 1] ?? null;
    const source = mine.find((r) => r.source !== null)?.source ?? null;

    let status: WorkSessionStatus;
    let timing: string;
    let closedLate = false;
    if (done) {
      status = "done";
      timing = `${formatDuration(done.attestedAt - first.attestedAt)} elapsed`;
      const before = mine.filter((r) => r !== done && r.attestedAt <= done.attestedAt);
      const prev = before[before.length - 1];
      closedLate = prev !== undefined && done.attestedAt - prev.attestedAt > LOST_AFTER_MS;
    } else {
      const idle = now - last.attestedAt;
      status = idle > LOST_AFTER_MS ? "lost" : "open";
      timing = `last record ${formatDuration(idle)} ago`;
    }

    const items = done ? (done.openItems ?? []) : (lastHandoff?.openItems ?? []);
    rows.push({
      startedAt: first.attestedAt,
      row: {
        id,
        status,
        started: formatWhen(first.attestedAt),
        startedImplicitly: first.startedImplicitly,
        tool: source === null ? "Tool not observed" : SOURCE_LABELS[source],
        chats: 1 + mine.filter((r) => r.kind === "continue").length,
        handoffs: handoffs.length,
        rating: done?.rating != null ? `${done.rating}/10` : null,
        timing,
        closedLate,
        summary: done?.summary ?? null,
        openItems: items,
        openItemsHeading:
          items.length === 0 ? null : done ? "Open items at /done" : "Open items at the last handoff",
        provenanceNote: done
          ? provenanceNote([
              ["summary", done.provenance.summary],
              ["open items", done.provenance.openItems],
            ])
          : lastHandoff
            ? provenanceNote([["open items", lastHandoff.provenance.openItems]])
            : null,
      },
    });
  }

  return rows.sort((a, b) => b.startedAt - a.startedAt).map((r) => r.row);
}
