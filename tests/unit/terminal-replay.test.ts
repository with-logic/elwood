/**
 * Unit tests for the bounded live-only terminal replay buffer (PRD §5.3, C-CLI-05): the byte
 * bound holds, and trimming never splits a multibyte UTF-8 sequence into a leading U+FFFD.
 */

import { describe, expect, test } from "vitest";
import { TerminalReplayBuffer } from "../../src/core/terminal-replay.ts";

function replayed(buffer: TerminalReplayBuffer): string {
  const out: string[] = [];
  buffer.replay((event) => out.push(event.data));
  return out.join("");
}

describe("TerminalReplayBuffer", () => {
  test("C-CLI-05 an over-limit single chunk is trimmed on a code-point boundary, never to U+FFFD", () => {
    // "aééb" is 6 bytes (each "é" is 2). A 4-byte bound cuts INSIDE the first "é": the kept
    // tail must start at the next complete code point, not at a stray continuation byte that
    // would decode as U+FFFD.
    const buffer = new TerminalReplayBuffer("elwood-7", 4);
    buffer.push("aééb");
    const data = replayed(buffer);
    expect(data).toBe("éb");
    expect(data.includes("\ufffd")).toBe(false);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(4);
  });

  test("C-CLI-05 a bound smaller than one 4-byte code point yields an empty, well-formed tail", () => {
    // Every byte inside the emoji is a continuation byte past the cut, so the skip runs to the
    // end of the chunk: nothing partial is ever decoded.
    const buffer = new TerminalReplayBuffer("elwood-8", 2);
    buffer.push("😀");
    expect(replayed(buffer)).toBe("");
  });

  test("C-CLI-05 oldest whole chunks are dropped first; a lone over-limit head is trimmed", () => {
    const buffer = new TerminalReplayBuffer("elwood-9", 6);
    buffer.push("xyz"); // dropped whole once the next chunk overflows the bound
    buffer.push("ñabcdef"); // 8 bytes: now the ONLY chunk → trimmed to its last 6 bytes
    expect(replayed(buffer)).toBe("abcdef");
    buffer.push("g"); // 7 > 6 with two chunks → the trimmed head is dropped whole
    expect(replayed(buffer)).toBe("g");
  });

  test("C-CLI-05 replay is a no-op with nothing buffered", () => {
    const buffer = new TerminalReplayBuffer("elwood-10");
    expect(replayed(buffer)).toBe("");
  });
});
