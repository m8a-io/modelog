import type { FieldProvenance } from "../markers/vocabulary.ts";
import {
  BRIEF_MAX,
  OPEN_ITEMS_MAX,
  OPEN_ITEM_MAX,
  SUMMARY_MAX,
  WORK_RECORD_KINDS,
  type WorkRecordKind,
} from "./records.ts";

/**
 * Argument validation for `modelog_save_work_record`. Pure. Which fields a
 * kind may carry is restated by the table's CHECK constraints; this is the
 * layer that explains a refusal in words an agent can act on.
 */
export interface WorkRecordInput {
  kind: WorkRecordKind;
  continuesFrom: string | null;
  rating: number | null;
  summary: string | null;
  openItems: string[] | null;
  brief: string | null;
  provenance: { summary: FieldProvenance | null; openItems: FieldProvenance | null; brief: FieldProvenance | null };
}

export type ValidateWorkRecord = { ok: true; value: WorkRecordInput } | { ok: false; error: string };

const ARGS = ["kind", "continuesFrom", "rating", "summary", "openItems", "brief", "provenance", "developerApproved"];

/** Which optional fields each kind accepts. Anything else given is refused, not ignored. */
const ALLOWED: Record<WorkRecordKind, ReadonlySet<string>> = {
  start: new Set([]),
  continue: new Set(["continuesFrom"]),
  handoff: new Set(["continuesFrom", "brief", "openItems", "provenance"]),
  done: new Set(["continuesFrom", "rating", "summary", "openItems", "provenance"]),
};

function text(v: unknown, name: string, max: number): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof v !== "string") return { ok: false, error: `${name} must be a string.` };
  const s = v.trim();
  if (s.length === 0) return { ok: false, error: `${name} must not be empty.` };
  if (s.length > max) return { ok: false, error: `${name} must be at most ${max} characters.` };
  return { ok: true, value: s };
}

function prov(v: unknown, name: string): { ok: true; value: FieldProvenance } | { ok: false; error: string } {
  if (v === "user" || v === "generated") return { ok: true, value: v };
  return { ok: false, error: `provenance.${name} must be "user" or "generated".` };
}

export function validateWorkRecordInput(args: Record<string, unknown>): ValidateWorkRecord {
  for (const k of Object.keys(args)) {
    if (!ARGS.includes(k)) return { ok: false, error: `Unknown argument. Allowed: ${ARGS.join(", ")}.` };
  }
  if (args.developerApproved !== true) {
    return {
      ok: false,
      error:
        "developerApproved must be true. Show the developer the exact record first and " +
        "save it only after they confirm; nothing is stored otherwise.",
    };
  }
  const kind = args.kind as WorkRecordKind;
  if (!WORK_RECORD_KINDS.includes(kind)) {
    return { ok: false, error: `kind must be one of: ${WORK_RECORD_KINDS.join(", ")}.` };
  }
  for (const k of Object.keys(args)) {
    if (k === "kind" || k === "developerApproved") continue;
    if (args[k] === undefined || args[k] === null) continue;
    if (k === "provenance" && typeof args[k] === "object" && Object.keys(args[k] as object).length === 0) continue;
    if (!ALLOWED[kind].has(k)) return { ok: false, error: `A ${kind} record takes no ${k}; omit it.` };
  }

  const value: WorkRecordInput = {
    kind,
    continuesFrom: null,
    rating: null,
    summary: null,
    openItems: null,
    brief: null,
    provenance: { summary: null, openItems: null, brief: null },
  };

  if (args.continuesFrom !== undefined && args.continuesFrom !== null) {
    if (typeof args.continuesFrom !== "string" || args.continuesFrom.trim() === "") {
      return { ok: false, error: "continuesFrom must be the id of a handoff." };
    }
    value.continuesFrom = args.continuesFrom.trim();
  }
  if (kind === "continue" && value.continuesFrom === null) {
    return { ok: false, error: "A continue record needs continuesFrom: the id of the handoff it continues." };
  }

  const p = (args.provenance ?? {}) as Record<string, unknown>;
  if (args.provenance !== undefined && (typeof args.provenance !== "object" || args.provenance === null)) {
    return { ok: false, error: "provenance must be an object." };
  }
  for (const k of Object.keys(p)) {
    if (!["summary", "openItems", "brief"].includes(k)) {
      return { ok: false, error: "provenance takes only summary, openItems and brief." };
    }
  }

  if (kind === "done") {
    const r = args.rating;
    if (typeof r !== "number" || !Number.isInteger(r) || r < 1 || r > 10) {
      return {
        ok: false,
        error: "rating is required: a whole number from 1 to 10, given by the developer.",
      };
    }
    value.rating = r;
    const s = text(args.summary, "summary", SUMMARY_MAX);
    if (!s.ok) return s;
    value.summary = s.value;
    const sp = prov(p.summary, "summary");
    if (!sp.ok) return sp;
    value.provenance.summary = sp.value;
  }

  if (kind === "handoff") {
    const b = text(args.brief, "brief", BRIEF_MAX);
    if (!b.ok) return b;
    value.brief = b.value;
    const bp = prov(p.brief, "brief");
    if (!bp.ok) return bp;
    value.provenance.brief = bp.value;
  }

  if (args.openItems !== undefined && args.openItems !== null) {
    if (!Array.isArray(args.openItems)) return { ok: false, error: "openItems must be a list of strings." };
    if (args.openItems.length > OPEN_ITEMS_MAX) {
      return { ok: false, error: `openItems takes at most ${OPEN_ITEMS_MAX} items.` };
    }
    const items: string[] = [];
    for (const it of args.openItems) {
      const t = text(it, "each open item", OPEN_ITEM_MAX);
      if (!t.ok) return t;
      items.push(t.value);
    }
    value.openItems = items;
    const op = prov(p.openItems, "openItems");
    if (!op.ok) return op;
    value.provenance.openItems = op.value;
  }

  // Provenance for a field that was not given is a contradiction, not a no-op.
  if (p.summary !== undefined && value.summary === null) return { ok: false, error: "provenance.summary given with no summary." };
  if (p.brief !== undefined && value.brief === null) return { ok: false, error: "provenance.brief given with no brief." };
  if (p.openItems !== undefined && value.openItems === null) return { ok: false, error: "provenance.openItems given with no openItems." };

  return { ok: true, value };
}
