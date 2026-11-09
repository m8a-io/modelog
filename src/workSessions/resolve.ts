import type { TurnSource } from "../ingest/adapter.ts";
import type { ChatIdSource, WorkRecord } from "./records.ts";
import type { WorkRecordInput } from "./validate.ts";

/**
 * Which work session a new record belongs to, and what the read tool shows.
 * Pure: given the records already stored and what the server observed about
 * the calling chat, it decides; the append connection only executes.
 *
 * Membership is decided from the records alone, never from measured turns, so
 * the store's ingest lag cannot affect it (PRD §7.25).
 */

/** What the MCP server can observe about the chat that called it. Never supplied by the agent. */
export interface Observed {
  chatSessionId: string | null;
  chatSessionIdSource: ChatIdSource | null;
  cwd: string | null;
  source: TurnSource | null;
}

/**
 * Claude Code starts one MCP server per chat and puts the chat's id in its
 * environment (verified 2026-11-08, Claude Code 2.1.319). That variable is
 * also the only observation of the tool: without it, the source is left
 * unknown rather than guessed from a client name nobody has verified.
 * Known limit: after Claude Code's built-in `/clear` the server keeps the old id.
 */
export function observeIdentity(env: Record<string, string | undefined>, cwd: string | null): Observed {
  const id = env.CLAUDE_CODE_SESSION_ID?.trim() || null;
  return {
    chatSessionId: id,
    chatSessionIdSource: id === null ? null : "client-env",
    cwd,
    source: id === null ? null : "claude-code",
  };
}

/** A repeat within this window is an agent's retry, not a second record. */
export const DUPLICATE_WINDOW_MS = 10 * 60_000;

export type Resolution =
  | { kind: "insert"; record: WorkRecord }
  | { kind: "duplicate"; record: WorkRecord }
  | { kind: "refuse"; reason: string };

function isClosed(records: readonly WorkRecord[], workSessionId: string): boolean {
  return records.some((r) => r.workSessionId === workSessionId && r.kind === "done");
}

function sameItems(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function resolveAppend(
  existing: readonly WorkRecord[],
  input: WorkRecordInput,
  observed: Observed,
  stamp: { id: string; originId: string | null; clientName: string | null; clientVersion: string | null; now: number },
): Resolution {
  // A retry first: otherwise a retried continue would be refused as "already continued".
  const dup = [...existing].reverse().find(
    (r) =>
      r.kind === input.kind &&
      r.chatSessionId === observed.chatSessionId &&
      r.continuesFrom === input.continuesFrom &&
      r.rating === input.rating &&
      r.summary === input.summary &&
      r.brief === input.brief &&
      sameItems(r.openItems, input.openItems) &&
      r.attestedAt >= stamp.now - DUPLICATE_WINDOW_MS,
  );
  if (dup) return { kind: "duplicate", record: dup };

  let workSessionId: string | null = null;
  let startedImplicitly = false;

  if (input.continuesFrom !== null) {
    const target = existing.find((r) => r.id === input.continuesFrom);
    if (!target || target.kind !== "handoff") {
      return { kind: "refuse", reason: "No handoff with that id exists in this Modelog store." };
    }
    if (observed.source !== null && target.source !== null && observed.source !== target.source) {
      return {
        kind: "refuse",
        reason: "That handoff was written in another tool, and a work session stays in one tool.",
      };
    }
    if (observed.chatSessionId !== null && target.chatSessionId === observed.chatSessionId) {
      return { kind: "refuse", reason: "This chat wrote that handoff; it is continued from a new chat." };
    }
    if (existing.some((r) => r.continuesFrom === target.id)) {
      return { kind: "refuse", reason: "Another chat has already continued that handoff." };
    }
    if (isClosed(existing, target.workSessionId)) {
      return { kind: "refuse", reason: "That work session has already been closed with /done." };
    }
    workSessionId = target.workSessionId;
  } else if (input.kind !== "start" && observed.chatSessionId !== null) {
    const latest = [...existing].reverse().find((r) => r.chatSessionId === observed.chatSessionId);
    if (latest && !isClosed(existing, latest.workSessionId)) workSessionId = latest.workSessionId;
  }

  if (workSessionId === null) {
    // A new work session, whose id is its first record's. Explicit only for /start (W4).
    workSessionId = stamp.id;
    startedImplicitly = input.kind !== "start";
  }

  return {
    kind: "insert",
    record: {
      id: stamp.id,
      kind: input.kind,
      workSessionId,
      continuesFrom: input.continuesFrom,
      startedImplicitly,
      rating: input.rating,
      summary: input.summary,
      openItems: input.openItems,
      brief: input.brief,
      provenance: input.provenance,
      chatSessionId: observed.chatSessionId,
      chatSessionIdSource: observed.chatSessionIdSource,
      cwd: observed.cwd,
      source: observed.source,
      originId: stamp.originId,
      attestedAt: stamp.now,
      clientName: stamp.clientName,
      clientVersion: stamp.clientVersion,
    },
  };
}

// --- what the read tool and a save return ------------------------------------------

export interface HandoffView {
  handoffId: string;
  attestedAt: string;
  brief: string | null;
  openItems: readonly string[];
}

export interface WaitingHandoff {
  handoffId: string;
  attestedAt: string;
  /** The brief's opening words, for a label in the developer's question. */
  briefStart: string;
}

export interface CurrentWorkSession {
  workSessionId: string;
  startedAt: string;
  startedImplicitly: boolean;
  handoffs: number;
  /** This work session's handoffs, oldest first: what earlier chats left for later ones. */
  earlierHandoffs: HandoffView[];
}

export interface WorkSessionsView {
  current: CurrentWorkSession | null;
  waiting: WaitingHandoff[];
}

const iso = (ts: number): string => new Date(ts).toISOString();

export const BRIEF_START_MAX = 80;

export function briefStart(brief: string | null): string {
  const flat = (brief ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= BRIEF_START_MAX) return flat;
  const cut = flat.slice(0, BRIEF_START_MAX);
  const space = cut.lastIndexOf(" ");
  return (space > BRIEF_START_MAX / 2 ? cut.slice(0, space) : cut) + "…";
}

function handoffView(r: WorkRecord): HandoffView {
  return { handoffId: r.id, attestedAt: iso(r.attestedAt), brief: r.brief, openItems: r.openItems ?? [] };
}

export function currentWorkSession(records: readonly WorkRecord[], workSessionId: string): CurrentWorkSession {
  const mine = records.filter((r) => r.workSessionId === workSessionId);
  const first = mine[0];
  const handoffs = mine.filter((r) => r.kind === "handoff");
  return {
    workSessionId,
    startedAt: iso(first.attestedAt),
    startedImplicitly: first.startedImplicitly,
    handoffs: handoffs.length,
    earlierHandoffs: handoffs.map(handoffView),
  };
}

/**
 * The chat's own open work session (only where its id is observed), and the
 * handoffs waiting for a chat to continue them: not yet claimed, work session
 * not closed, same folder and same tool where both are known, and not written
 * by this chat. Newest first.
 */
export function workSessionsView(records: readonly WorkRecord[], observed: Observed): WorkSessionsView {
  let current: CurrentWorkSession | null = null;
  if (observed.chatSessionId !== null) {
    const latest = [...records].reverse().find((r) => r.chatSessionId === observed.chatSessionId);
    if (latest && !isClosed(records, latest.workSessionId)) {
      current = currentWorkSession(records, latest.workSessionId);
    }
  }

  const claimed = new Set(records.map((r) => r.continuesFrom).filter((x): x is string => x !== null));
  const waiting = records
    .filter(
      (r) =>
        r.kind === "handoff" &&
        !claimed.has(r.id) &&
        !isClosed(records, r.workSessionId) &&
        (observed.cwd === null || r.cwd === null || r.cwd === observed.cwd) &&
        (observed.source === null || r.source === null || r.source === observed.source) &&
        (observed.chatSessionId === null || r.chatSessionId !== observed.chatSessionId),
    )
    .sort((a, b) => b.attestedAt - a.attestedAt)
    .map((r) => ({ handoffId: r.id, attestedAt: iso(r.attestedAt), briefStart: briefStart(r.brief) }));

  return { current, waiting };
}
