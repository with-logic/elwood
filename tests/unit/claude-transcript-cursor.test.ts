/**
 * Byte-accuracy and current-turn recovery for the Claude transcript cursor.
 * Covers PRD §5.4 (C-CLAUDE-15): bounded reads that never corrupt on a UTF-8
 * boundary and a backward scan that recovers the whole current turn.
 */

import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { TranscriptCursor } from "../../src/claude/transcript/cursor.ts";

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

  test("baselineTail decodes a code point split EXACTLY at a 64 KiB backward-block seam", () => {
    // The backward baseline scan steps back in 64 KiB blocks; the first seam is at
    // `size - 64 KiB`. A 4-byte 🎯 whose bytes straddle that seam decodes to U+FFFD
    // if the block start drops a partial leading code point. The fixture places the
    // emoji so exactly two of its bytes fall below the seam and two above: with
    // (remaining emoji bytes + suffix bytes) == step, the seam lands at emojiStart+2.
    // The user boundary sits deeper still, so the scan must cross the seam.
    const step = 64 * 1024;
    const marker = "🎯TARGET-MARKER"; // 🎯 is 4 UTF-8 bytes; the ASCII marker follows
    const closeAsst = '"}]}}\n';
    // Suffix after the emoji's 4 bytes must total `step - 2` so the seam is at +2.
    const afterEmoji = marker.slice("🎯".length); // "TARGET-MARKER"
    const padLen = step - 2 - Buffer.byteLength(afterEmoji) - Buffer.byteLength(closeAsst);
    const suffix = `${afterEmoji}${"z".repeat(padLen)}${closeAsst}`;
    const boundary = `${user("go")}\n`;
    const head = `${'{"type":"assistant","message":{"content":[{"type":"text","text":"'}${"y".repeat(4096)}`;
    const path = tmpFile();
    writeFileSync(path, `${boundary}${head}🎯${suffix}`);
    const seam = statSync(path).size - step;
    const emojiStart = Buffer.byteLength(`${boundary}${head}`);
    expect(emojiStart).toBe(seam - 2); // 🎯 starts two bytes below the seam …
    expect(emojiStart + 4).toBeGreaterThan(seam); // … and ends above it: it straddles
    const tail = new TranscriptCursor(path).baselineTail().text;
    expect(tail).toContain(marker); // emoji + marker recovered intact
    expect(tail).not.toContain("�"); // no replacement character at the seam
  });

  test("baselineTail recovers a current turn that spans MULTIPLE backward steps", () => {
    // The user boundary sits far enough back that a single 64KB window misses it;
    // the backward scan must step until it finds the boundary and return the
    // whole current turn.
    const path = tmpFile();
    const big = "z".repeat(80 * 1024); // one filler assistant line > one step
    writeFileSync(path, `${user("go")}\n${asst(big)}\n${asst("final")}\n`);
    const tail = new TranscriptCursor(path).baselineTail().text;
    expect(tail).toContain(big);
    expect(tail).toContain("final");
    expect(tail).not.toContain('"content":"go"'); // prior user turn not included
  });

  test("baselineTail returns nothing when the file has NO user boundary at all", () => {
    const path = tmpFile();
    writeFileSync(path, `${asst("only-assistant-history")}\n`);
    expect(new TranscriptCursor(path).baselineTail().text).toBe("");
  });

  test("a Stop-first turn LARGER than the 4 MiB cap recovers its in-window records", () => {
    // Regression for the silent whole-turn loss: a ~4.3 MB turn whose user prompt
    // sits beyond the baseline cap must NOT return empty (dropping every committed
    // record with no trace). The cap is hit before the boundary, so the in-window
    // bounded records are recovered instead of discarded (C-CLAUDE-15).
    const path = tmpFile();
    const filler = asst("x".repeat(200 * 1024)); // ~200 KiB per assistant record
    const records = Array.from({ length: 22 }, (_, i) => asst(`rec-${i}`)); // near the tail
    // Prompt is buried under > 4 MiB of filler, so the backward scan hits the cap
    // before reaching it. The tail records are all within the cap window.
    const body = `${user("go")}\n${Array.from({ length: 22 }, () => filler).join("\n")}\n`;
    writeFileSync(path, `${body}${records.join("\n")}\n`);
    const tail = new TranscriptCursor(path).baselineTail().text;
    expect(tail).not.toBe(""); // the whole turn is NOT silently dropped
    expect(tail).toContain("rec-21"); // the newest in-window committed record survives
    expect(tail).not.toContain('"content":"go"'); // the out-of-window prompt is not reached
  });

  test("baselineTail is empty for a new/empty file", () => {
    const path = tmpFile();
    writeFileSync(path, "");
    expect(new TranscriptCursor(path).baselineTail().text).toBe("");
  });

  test("a malformed line in the tail window does not break boundary detection", () => {
    const path = tmpFile();
    writeFileSync(path, `{ bad\n${user("go")}\n${asst("cur")}\n`);
    expect(new TranscriptCursor(path).baselineTail().text).toContain("cur");
  });

  test("a line that carries the user marker but is not a user PROMPT is not a boundary", () => {
    // The cheap prefilter admits any line containing `"user"`. Two such non-prompt
    // lines must still be rejected: (1) a broken JSON line that carries the marker
    // reaches and FAILS JSON.parse; (2) a VALID assistant record whose prose merely
    // mentions "user" parses but its `type` is not "user". Neither is the boundary —
    // the real prompt above them is.
    const path = tmpFile();
    const brokenUser = '{"type":"user", broken'; // has `"user"` but is not valid JSON
    // Valid JSON whose type is NOT "user" but which carries the bare `"user"` token
    // (as another field's value), so it passes the prefilter yet fails the type check.
    const asstMentionsUser = '{"type":"assistant","author":"user","message":{"content":"hi"}}';
    writeFileSync(path, `${user("go")}\n${brokenUser}\n${asstMentionsUser}\n${asst("cur")}\n`);
    const tail = new TranscriptCursor(path).baselineTail().text;
    expect(tail).toContain("cur");
    expect(tail).toContain(brokenUser); // the broken line is part of the current turn
    expect(tail).toContain(asstMentionsUser); // the assistant mention is not a boundary
    expect(tail).not.toContain('"content":"go"'); // the real prompt is the boundary
  });

  test("a tool_result user record is NOT the boundary; the whole current turn recovers", () => {
    // The current turn: user prompt → assistant tool_use → user tool_result →
    // final assistant text. A tool_result is a `type:"user"` record, so a naive
    // "last user record" boundary would drop the tool_use + tool_result. The
    // boundary must be the real PROMPT, recovering all committed tool activity.
    const toolUse = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    });
    const toolResult = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] },
    });
    const path = tmpFile();
    writeFileSync(
      path,
      `${user("prev")}\n${asst("old")}\n${user("go")}\n${toolUse}\n${toolResult}\n${asst("final")}\n`,
    );
    const tail = new TranscriptCursor(path).baselineTail().text;
    expect(tail).toContain('"name":"Read"'); // tool_use recovered
    expect(tail).toContain('"tool_use_id":"t1"'); // tool_result recovered
    expect(tail).toContain("final"); // final assistant text recovered
    expect(tail).not.toContain('"content":"go"'); // the prompt boundary is excluded
    expect(tail).not.toContain('"content":"prev"'); // the prior turn is not replayed
  });

  test("a user record whose content is neither string nor array is not a boundary", () => {
    // A malformed/object content shape must not be treated as a prompt boundary;
    // the scan keeps going back to the real prompt above it.
    const path = tmpFile();
    const oddUser = JSON.stringify({ type: "user", message: { content: { note: "x" } } });
    writeFileSync(path, `${user("go")}\n${oddUser}\n${asst("cur")}\n`);
    const tail = new TranscriptCursor(path).baselineTail().text;
    expect(tail).toContain("cur");
    expect(tail).toContain(oddUser); // the odd record is part of the current turn
    expect(tail).not.toContain('"content":"go"'); // real prompt is the boundary
  });

  test("a user record with an array of prose (text block) is a boundary", () => {
    // Some prompts arrive as a content array with a `text` block rather than a
    // bare string; that is still a real prompt and thus a boundary.
    const path = tmpFile();
    const arrayPrompt = JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "go" }] },
    });
    writeFileSync(path, `${arrayPrompt}\n${asst("cur")}\n`);
    const tail = new TranscriptCursor(path).baselineTail().text;
    expect(tail).toContain("cur");
    expect(tail).not.toContain('"text":"go"'); // the prompt boundary is excluded
  });
});
