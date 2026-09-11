/**
 * Bounded live-only terminal replay (PRD §5.3/§8.3, C-PTY-03): a single chunk larger
 * than the buffer is trimmed to its tail rather than replayed whole.
 */

import { describe, expect, test } from "vitest";
import { TerminalReplayBuffer } from "../../src/core/terminal-replay.ts";

describe("TerminalReplayBuffer bounds", () => {
  test("C-PTY-03 a single oversized chunk is trimmed to the byte cap", () => {
    const buffer = new TerminalReplayBuffer("e1", 4);
    const replayed: string[] = [];
    buffer.push("abcdef");
    buffer.replay((event) => replayed.push(event.data));
    expect(replayed).toEqual(["cdef"]);
  });
});
