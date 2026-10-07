import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../src/ingest/scanner.ts";
import { claudeCodeAdapter } from "../src/ingest/claudeCode.ts";
import type { SourceAdapter } from "../src/ingest/adapter.ts";
import type { Turn, FileCursor, ParseResult } from "../src/ingest/types.ts";
import type { Store } from "../src/store/index.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "modelog-adapter-"));
}

/** Minimal in-memory Store — these tests are about dispatch, not persistence. */
function fakeStore(): Store & { turns: Turn[]; cursors: Map<string, FileCursor> } {
  const turns: Turn[] = [];
  const cursors = new Map<string, FileCursor>();
  return {
    turns,
    cursors,
    backend: "file",
    upsertTurns: (t) => { turns.push(...t); },
    allTurns: () => turns,
    turnCount: () => turns.length,
    getCursor: (p) => cursors.get(p),
    setCursor: (c) => { cursors.set(c.path, c); },
    exportJson: () => "{}",
    clear: () => { turns.length = 0; cursors.clear(); },
    close: () => {},
  };
}

/** Records every chunk it is handed, so the test can assert what was read. */
function recordingAdapter(
  source: SourceAdapter["source"],
  mode: SourceAdapter["mode"],
  suffix: string,
): SourceAdapter & { chunks: string[] } {
  const chunks: string[] = [];
  return {
    chunks,
    source,
    mode,
    findFiles: (root) =>
      readdirSync(root)
        .filter((f) => f.endsWith(suffix))
        .map((f) => join(root, f)),
    parse: (text: string): ParseResult => {
      chunks.push(text);
      return { turns: [], diagnostics: [], remainder: "" };
    },
  };
}

test("each root is offered to every adapter, and each claims only its own files", () => {
  const root = tmpDir();
  writeFileSync(join(root, "a.claude"), "one\n");
  writeFileSync(join(root, "b.copilot"), "two\n");

  const cc = recordingAdapter("claude-code", "tail", ".claude");
  const cop = recordingAdapter("copilot", "whole-file", ".copilot");
  scan(fakeStore(), [root], [cc, cop]);

  assert.deepEqual(cc.chunks, ["one\n"]);
  assert.deepEqual(cop.chunks, ["two\n"]);
});

test("a tail adapter resumes from its byte offset and sees only what was appended", () => {
  const root = tmpDir();
  const file = join(root, "a.claude");
  writeFileSync(file, "first\n");

  const cc = recordingAdapter("claude-code", "tail", ".claude");
  const store = fakeStore();
  scan(store, [root], [cc]);
  appendFileSync(file, "second\n");
  scan(store, [root], [cc]);

  assert.deepEqual(cc.chunks, ["first\n", "second\n"]);
});

test("a whole-file adapter re-reads from zero, because its records only parse as a set", () => {
  const root = tmpDir();
  const file = join(root, "a.copilot");
  writeFileSync(file, "first\n");

  const cop = recordingAdapter("copilot", "whole-file", ".copilot");
  const store = fakeStore();
  scan(store, [root], [cop]);
  appendFileSync(file, "second\n");
  scan(store, [root], [cop]);

  assert.deepEqual(cop.chunks, ["first\n", "first\nsecond\n"]);
});

test("an unchanged file is skipped in either mode", () => {
  const root = tmpDir();
  writeFileSync(join(root, "a.copilot"), "x\n");

  const cop = recordingAdapter("copilot", "whole-file", ".copilot");
  const store = fakeStore();
  scan(store, [root], [cop]);
  scan(store, [root], [cop]);

  assert.equal(cop.chunks.length, 1);
});

test("a file above the read cap is reported, not loaded", () => {
  const root = tmpDir();
  const file = join(root, "big.copilot");
  // Sparse-ish write: one byte past the cap is enough to trip it.
  writeFileSync(file, Buffer.alloc(33 * 1024 * 1024, 0x61));

  const cop = recordingAdapter("copilot", "whole-file", ".copilot");
  const result = scan(fakeStore(), [root], [cop]);

  assert.equal(cop.chunks.length, 0, "an oversized file must not be parsed");
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0].detail, /read cap/);
});

test("a missing root is reported rather than thrown", () => {
  const result = scan(fakeStore(), [join(tmpDir(), "nope")], [claudeCodeAdapter]);
  assert.equal(result.missingPaths.length, 1);
});

test("the Claude Code adapter still finds .jsonl recursively, and nothing else", () => {
  const root = tmpDir();
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(join(root, "nested", "session.jsonl"), "");
  writeFileSync(join(root, "notes.md"), "");

  const found = claudeCodeAdapter.findFiles(root);
  assert.deepEqual(found, [join(root, "nested", "session.jsonl")]);
});

test("the Claude Code adapter declares itself as a tailing source", () => {
  assert.equal(claudeCodeAdapter.source, "claude-code");
  assert.equal(claudeCodeAdapter.mode, "tail");
});
