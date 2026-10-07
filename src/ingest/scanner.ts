import { statSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { claudeCodeAdapter } from "./claudeCode.ts";
import type { SourceAdapter } from "./adapter.ts";
import type { Diagnostic, FileCursor } from "./types.ts";
import type { Store } from "../store/index.ts";

/**
 * A single read is capped, because a log is not guaranteed to be small: a real
 * Copilot session log measured 13 MB, and its retention limit is user-settable
 * (PRD §7.1 corrections). Allocating a whole file into the extension host is
 * not acceptable at an unbounded size, so an oversized read is reported as a
 * diagnostic rather than attempted.
 */
const MAX_READ_BYTES = 32 * 1024 * 1024;

export interface ScanResult {
  filesScanned: number;
  turnsIngested: number;
  diagnostics: Diagnostic[];
  missingPaths: string[];
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : resolve(p);
}

/**
 * Walk the configured log directories and ingest anything new.
 *
 * Each root is offered to every adapter, and an adapter claims the files it
 * recognises. Incremental by byte offset where the adapter allows it: JSONL
 * files are append-only, so a `tail` adapter reads only from where it stopped.
 * A file whose size DECREASED was rotated or rewritten, so we re-read it
 * whole. Upserts key on the record uuid, which makes a full rescan safe at
 * any time — and is what lets a `whole-file` adapter re-read without
 * duplicating anything.
 */
export function scan(
  store: Store,
  logPaths: readonly string[],
  adapters: readonly SourceAdapter[] = [claudeCodeAdapter],
): ScanResult {
  const result: ScanResult = {
    filesScanned: 0,
    turnsIngested: 0,
    diagnostics: [],
    missingPaths: [],
  };

  for (const raw of logPaths) {
    const root = expandHome(raw);
    if (!existsSync(root)) {
      result.missingPaths.push(root);
      continue;
    }
    for (const adapter of adapters) {
      for (const file of adapter.findFiles(root)) {
        ingestFile(store, file, adapter, result);
      }
    }
  }

  return result;
}

function ingestFile(
  store: Store,
  path: string,
  adapter: SourceAdapter,
  result: ScanResult,
): void {
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }

  const prev = store.getCursor(path);
  // Unchanged since last read — true for either mode.
  if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return;

  // Shrunk => rotated or rewritten => start over. A whole-file adapter always
  // starts over, because its records are only parseable as a complete set.
  const from =
    adapter.mode === "whole-file" ? 0 : prev && st.size >= prev.size ? prev.byteOffset : 0;
  if (from >= st.size) return;

  const length = st.size - from;
  if (length > MAX_READ_BYTES) {
    result.diagnostics.push({
      kind: "unknown-shape",
      file: path,
      line: 0,
      detail: `file is ${length} bytes, above the ${MAX_READ_BYTES}-byte read cap; skipped`,
    });
    return;
  }

  const text = readFrom(path, from, length);
  if (text === null) return;

  const { turns, diagnostics, remainder } = adapter.parse(text, path);
  store.upsertTurns(turns);

  // Rewind past a partial trailing line so the next read picks it up whole.
  // A whole-file adapter re-reads from zero regardless, so its cursor records
  // only the size+mtime that let an unchanged file be skipped.
  const consumed =
    adapter.mode === "whole-file" ? 0 : st.size - Buffer.byteLength(remainder, "utf8");
  const cursor: FileCursor = {
    path,
    size: st.size,
    mtimeMs: st.mtimeMs,
    byteOffset: consumed,
  };
  store.setCursor(cursor);

  result.filesScanned++;
  result.turnsIngested += turns.length;
  result.diagnostics.push(...diagnostics);
}

function readFrom(path: string, offset: number, length: number): string | null {
  if (length <= 0) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
