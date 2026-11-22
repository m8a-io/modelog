import type { TurnSource } from "../ingest/adapter.ts";
import type { FieldProvenance } from "../markers/vocabulary.ts";
import type { WorkRecord } from "./records.ts";

/**
 * The Dashboard's Work sessions tab (PRD §7.25, W8, W10). Pure: built from the
 * records alone, so it needs neither the store's turns nor the read-time chat
 * link. Measured figures per work session (cost, active time, context peaks)
 * are a later release; nothing here estimates them.
 */

/**
 * An open work session with no record for this long is labelled old (W8).
 * 30 days, maintainer 2026-11-22: waiting days for a client is normal, and the
 * 2-day threshold it replaces called that "lost".
 */
export const OLD_AFTER_MS = 30 * 86_400_000;

export type WorkSessionStatus = "open" | "old" | "done";

const STATUS_LABELS: Record<WorkSessionStatus, string> = {
  open: "Open",
  old: "Old, not done",
  done: "Done",
};

/** How one chat of a work session ended, or that it has not. */
export type ChatEnd = "handoff" | "done" | "open";

export interface WorkSessionChat {
  /** e.g. "11/09/2026, 4:35 PM": the chat's first record. */
  started: string;
  ended: ChatEnd;
  /** e.g. "Chat 2 · started 11/09/2026, 4:35 PM · handed off". */
  label: string;
}

const END_LABELS: Record<ChatEnd, string> = {
  handoff: "handed off",
  done: "closed by /done",
  open: "still open",
};

/**
 * The chat a Resume action would open (W7). Only an id observed through
 * Claude Code's environment qualifies: no other client offers a way to open
 * a chat, and an unobserved chat is never guessed.
 */
export interface ResumeTarget {
  chatSessionId: string;
  /** The folder the chat ran in, as the MCP server observed it. */
  cwd: string | null;
}

export interface WorkSessionRow {
  id: string;
  status: WorkSessionStatus;
  /** "Open", "Old, not done" or "Done". */
  statusLabel: string;
  /** e.g. "Started 11/09/2026, 4:35 PM". */
  started: string;
  startedImplicitly: boolean;
  /** "Claude Code", or "Tool not observed" where the server could not tell. */
  tool: string;
  /** One for the first chat, plus one per continued handoff. */
  chats: number;
  /** The chats in order, each with how it ended (W7). */
  chatList: readonly WorkSessionChat[];
  /** True when Resume can open the work session's still-open chat. */
  canResume: boolean;
  /** Why there is nothing to resume, for an open or old work session; null otherwise. */
  resumeNote: string | null;
  handoffs: number;
  /**
   * Done: first record to closure, e.g. "2 d 3 h elapsed". Open or old: time
   * since the last record. Elapsed includes every pause; active time needs the
   * measured turns and is not shown.
   */
  timing: string;
  /** Done only: the closure came more than OLD_AFTER_MS after the record before it (W8). */
  closedLate: boolean;
  summary: string | null;
  /** Done: the closure's open items. Open or old: the latest handoff's. */
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

/**
 * A work session's records split into chats. A chat starts at the first
 * record and at each `continue`, the same count the row has always shown, so
 * a record without an observed chat id still lands in the right chat.
 */
function chatSegments(mine: readonly WorkRecord[]): WorkRecord[][] {
  const segments: WorkRecord[][] = [];
  for (const r of mine) {
    if (segments.length === 0 || r.kind === "continue") segments.push([r]);
    else segments[segments.length - 1]!.push(r);
  }
  return segments;
}

function chatEnd(segment: readonly WorkRecord[]): ChatEnd {
  for (let i = segment.length - 1; i >= 0; i--) {
    const k = segment[i]!.kind;
    if (k === "done" || k === "handoff") return k;
  }
  return "open";
}

function byAttestation(records: readonly WorkRecord[], workSessionId: string): WorkRecord[] {
  return records
    .filter((r) => r.workSessionId === workSessionId)
    .sort((a, b) => a.attestedAt - b.attestedAt);
}

type ResumeState = { target: ResumeTarget } | { note: string };

function resumeState(mine: readonly WorkRecord[]): ResumeState | null {
  if (mine.some((r) => r.kind === "done")) return null;
  const segments = chatSegments(mine);
  const last = segments[segments.length - 1];
  if (!last) return null;
  if (chatEnd(last) === "handoff") {
    return { note: "Handed off and not continued yet: run /start in a new chat and pick this handoff." };
  }
  const observed = last.find((r) => r.chatSessionId !== null && r.chatSessionIdSource === "client-env");
  if (!observed) {
    return {
      note:
        last[0]!.source !== null && last[0]!.source !== "claude-code"
          ? "Opening a chat from here works for Claude Code only."
          : "This chat's id was not observed, so it cannot be opened from here.",
    };
  }
  return { target: { chatSessionId: observed.chatSessionId!, cwd: observed.cwd } };
}

/**
 * The still-open chat of an open or old work session, if one can be opened
 * (W7). Read by the host when the developer clicks Resume, from the store's
 * records, so the webview never names the chat it opens.
 */
export function resumeTarget(records: readonly WorkRecord[], workSessionId: string): ResumeTarget | null {
  const state = resumeState(byAttestation(records, workSessionId));
  return state !== null && "target" in state ? state.target : null;
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
      closedLate = prev !== undefined && done.attestedAt - prev.attestedAt > OLD_AFTER_MS;
    } else {
      const idle = now - last.attestedAt;
      status = idle > OLD_AFTER_MS ? "old" : "open";
      timing = `last record ${formatDuration(idle)} ago`;
    }

    const items = done ? (done.openItems ?? []) : (lastHandoff?.openItems ?? []);
    const chatList = chatSegments(mine).map((seg, i) => {
      const started = formatWhen(seg[0]!.attestedAt);
      const ended = chatEnd(seg);
      return { started, ended, label: `Chat ${i + 1} · started ${started} · ${END_LABELS[ended]}` };
    });
    const resume = resumeState(mine);
    rows.push({
      startedAt: first.attestedAt,
      row: {
        id,
        status,
        statusLabel: STATUS_LABELS[status],
        started: formatWhen(first.attestedAt),
        startedImplicitly: first.startedImplicitly,
        tool: source === null ? "Tool not observed" : SOURCE_LABELS[source],
        chats: chatList.length,
        chatList,
        canResume: resume !== null && "target" in resume,
        resumeNote: resume !== null && "note" in resume ? resume.note : null,
        handoffs: handoffs.length,
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
