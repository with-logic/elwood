/**
 * Byte-accuracy and current-turn recovery for the Claude transcript cursor.
 * Covers PRD §5.4 (C-CLAUDE-15): bounded reads that never corrupt on a UTF-8
 * boundary and a backward scan that recovers the whole current turn.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { TranscriptCursor } from "../../src/claude/transcript-cursor.ts";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "elwood-tx-")), "t.jsonl");
}

/** Drain a cursor to the end, returning the concatenated decoded text. */
function drainAll(cursor: TranscriptCursor): string {
  let out = "";
  for (let budget = 1000; budget > 0; budget--) {
    const { text, more } = cursor.readChunk();
    out += text;
    if (!more) break;
  }
  return out;
}

describe("C-CLAUDE-15 transcript cursor byte accuracy", () => {
  test("a multibyte UTF-8 character split across a chunk boundary is decoded intact", () => {
    // A 3-byte € straddles the 256KB read boundary. A naive decode+re-encode
    // would corrupt it into a replacement char and drift the offset; the cursor
    // must carry the partial bytes to the next read. The cursor baselines at 0
    // for an empty file, then reads the appended content incrementally.
    const path = tmpFile();
    writeFileSync(path, "");
    const cursor = new TranscriptCursor(path);
    // ASCII up to two bytes before the boundary, then € (its 3 bytes span it).
    const line = `${"x".repeat(256 * 1024 - 2)}€uro-test-marker`;
    writeFileSync(path, `${line}\n`);
    const text = drainAll(cursor);
    expect(text).toContain("€uro-test-marker");
    expect(text).not.toContain("�"); // no replacement character
  });
});

describe("C-CLAUDE-15 transcript cursor current-turn recovery", () => {
  const user = (t: string) => JSON.stringify({ type: "user", message: { content: t } });
  const asst = (t: string) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t }] } });

  test("baselineTail recovers a current turn that spans MULTIPLE backward steps", () => {
    // The user boundary sits far enough back that a single 64KB window misses it;
    // the backward scan must step until it finds the boundary and return the
    // whole current turn.
    const path = tmpFile();
    const big = "z".repeat(80 * 1024); // one filler assistant line > one step
    writeFileSync(path, `${user("go")}\n${asst(big)}\n${asst("final")}\n`);
    const tail = new TranscriptCursor(path).baselineTail();
    expect(tail).toContain(big);
    expect(tail).toContain("final");
    expect(tail).not.toContain('"content":"go"'); // prior user turn not included
  });

  test("baselineTail returns nothing when no user boundary is within the cap", () => {
    const path = tmpFile();
    writeFileSync(path, `${asst("only-assistant-history")}\n`);
    expect(new TranscriptCursor(path).baselineTail()).toBe("");
  });

  test("baselineTail is empty for a new/empty file", () => {
    const path = tmpFile();
    writeFileSync(path, "");
    expect(new TranscriptCursor(path).baselineTail()).toBe("");
  });

  test("a malformed line in the tail window does not break boundary detection", () => {
    const path = tmpFile();
    writeFileSync(path, `{ bad\n${user("go")}\n${asst("cur")}\n`);
    expect(new TranscriptCursor(path).baselineTail()).toContain("cur");
  });
});
