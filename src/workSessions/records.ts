import type { FieldProvenance } from "../markers/vocabulary.ts";
import type { TurnSource } from "../ingest/adapter.ts";

/**
 * Work-session records (PRD §7.25). Pure: no `vscode`, no database.
 *
 * A **chat session** is one conversation log, and every measured figure is
 * keyed by it. A **work session** is the developer's stretch of work: one or
 * more chats joined by `/handoff`, closed by `/done`. Modelog never infers a
 * work session. It exists only through these records, which the developer's
 * commands append through the MCP server and nothing ever updates.
 *
 * - `start`    — `/start` began a new work session in this chat.
 * - `continue` — `/start` in a new chat claimed a waiting handoff. The claim is
 *                its own record so it happens at that moment: two windows
 *                cannot both take one handoff (a unique index holds that).
 * - `handoff`  — `/handoff` ended a chat. Brief + open items, **no rating**.
 * - `done`     — `/done` closed the work session. Rating (required), summary,
 *                open items.
 */
export type WorkRecordKind = "start" | "continue" | "handoff" | "done";

export const WORK_RECORD_KINDS: readonly WorkRecordKind[] = ["start", "continue", "handoff", "done"];

/** Field caps, maintainer 2026-11-09. */
export const SUMMARY_MAX = 600;
export const OPEN_ITEMS_MAX = 10;
export const OPEN_ITEM_MAX = 200;
export const BRIEF_MAX = 1_500;

/**
 * How the chat id was learned. Only one way exists so far: Claude Code puts
 * `CLAUDE_CODE_SESSION_ID` in the environment of the MCP server it starts for
 * each chat (verified 2026-11-08). The agent never supplies an id.
 */
export type ChatIdSource = "client-env";

export interface WorkRecord {
  id: string;
  kind: WorkRecordKind;
  /** The id of the work session's first record. Set by the server. */
  workSessionId: string;
  /** On a chat's first record when it continues a handoff: that handoff's id. */
  continuesFrom: string | null;
  /** True on the first record of a work session that had no `/start` (W4). */
  startedImplicitly: boolean;
  /** `done` only, 1–10, always the developer's own answer. */
  rating: number | null;
  /** `done` only. */
  summary: string | null;
  /** `handoff` and `done`. */
  openItems: readonly string[] | null;
  /** `handoff` only. */
  brief: string | null;
  /** Per text field: drafted by the agent, or written by the developer. Null where the field is absent. */
  provenance: {
    summary: FieldProvenance | null;
    openItems: FieldProvenance | null;
    brief: FieldProvenance | null;
  };
  /** Observed by the server, never supplied by the agent. */
  chatSessionId: string | null;
  chatSessionIdSource: ChatIdSource | null;
  /** The MCP server process's working directory, as observed. */
  cwd: string | null;
  /** The tool (W5). Null where the server could not observe it. */
  source: TurnSource | null;
  /** Which install wrote the record (W9), from the store's meta table. */
  originId: string | null;
  /** Server clock. No record can be backdated. */
  attestedAt: number;
  clientName: string | null;
  clientVersion: string | null;
}
