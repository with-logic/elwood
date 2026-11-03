/**
 * Unit tests for the bounded, release-able startup output collector.
 * Covers PRD §9.1 startup usability and §9.4 resource cleanup: the collector
 * bounds early output, stops appending once released, and clears its retained
 * string so no per-session transcript lingers for the PTY handler's lifetime.
 */

import { describe, expect, test } from "vitest";
import { homeGuardStopMarker } from "../../src/runtime/home-guard/index.ts";
import { assertStartupThenRelease, createStartupBuffer } from "../../src/runtime/startup/buffer.ts";
import {
  resetStartupWaitMsForTests,
  setStartupWaitMsForTests,
} from "../../src/runtime/startup/index.ts";

describe("createStartupBuffer (§9.1, §9.4)", () => {
  test("collects chunks until read", () => {
    const buffer = createStartupBuffer();
    buffer.push("hello ");
    buffer.push("world");
    expect(buffer.read()).toBe("hello world");
  });

  test("reads its source PTY directly until release, then lets go of it", () => {
    const handlers: ((data: string) => void)[] = [];
    const source = {
      onData(handler: (data: string) => void) {
        handlers.push(handler);
        return () => handlers.splice(handlers.indexOf(handler), 1);
      },
    };
    const buffer = createStartupBuffer({ source });
    for (const handler of handlers) handler("banner");
    expect(buffer.read()).toBe("banner");
    buffer.release();
    expect(handlers).toEqual([]);
  });

  test("release stops collecting and clears the retained buffer", () => {
    const buffer = createStartupBuffer();
    buffer.push("startup banner");
    buffer.release();
    // Post-release chunks are dropped and the earlier content is cleared, so the
    // PTY handler never grows a second in-memory transcript for the session.
    buffer.push("later output that must not be retained");
    expect(buffer.read()).toBe("");
  });

  test("caps the buffer so a chatty CLI cannot balloon it", () => {
    const buffer = createStartupBuffer({ capBytes: 8 });
    buffer.push("1234");
    buffer.push("5678ABCD");
    // First push filled it to 4, the second is truncated at the 8-byte cap.
    expect(buffer.read()).toBe("12345678");
    // Once at the cap, further chunks are ignored.
    buffer.push("more");
    expect(buffer.read()).toBe("12345678");
  });

  test("§9.1 retains UTF-8 bytes rather than UTF-16 code units", () => {
    const buffer = createStartupBuffer({ capBytes: 7 });
    buffer.push("aé🙂z");
    expect(buffer.read()).toBe("aé🙂");
    expect(Buffer.byteLength(buffer.read(), "utf8")).toBe(7);
  });

  test.each([
    0, 1, 2, 3, 4,
  ])("§9.1 an astral code point requires all four bytes with %i available", (available) => {
    const buffer = createStartupBuffer({ capBytes: 2 + available });
    buffer.push("ab");
    buffer.push("🙂");
    expect(buffer.read()).toBe(available === 4 ? "ab🙂" : "ab");
    buffer.push("c");
    expect(buffer.read()).toBe(available === 4 ? "ab🙂" : "ab");
  });

  test("§9.1 later chunks cannot fill space after an unfit code point", () => {
    const buffer = createStartupBuffer({ capBytes: 5 });
    buffer.push("é");
    buffer.push("éé");
    expect(buffer.read()).toBe("éé");
    buffer.push("x");
    expect(buffer.read()).toBe("éé");
    buffer.release();
    buffer.push("later");
    expect(buffer.read()).toBe("");
  });

  test("C-E2E-24 watches for the home guard's stop marker past the cap, until release", () => {
    const buffer = createStartupBuffer({ capBytes: 8, watchStopMarker: true });
    const sawStopMarker = buffer.sawStopMarker ?? (() => expect.unreachable());
    buffer.push("profile output");
    expect(sawStopMarker()).toBe(false);
    buffer.push(homeGuardStopMarker.slice(0, 10));
    buffer.push(`${homeGuardStopMarker.slice(10)}: reason\r\n`);
    expect(buffer.read()).toBe("profile ");
    expect(sawStopMarker()).toBe(true);
    buffer.push("output after the marker");
    expect(sawStopMarker()).toBe(true);
    buffer.release();
    expect(sawStopMarker()).toBe(false);
    buffer.push(homeGuardStopMarker);
    expect(sawStopMarker()).toBe(false);
  });

  test("§9.1 an oversized chunk retains only the first 64 KiB prefix", () => {
    const buffer = createStartupBuffer();
    buffer.push("🙂".repeat(1_000_000));
    expect(buffer.read()).toBe("🙂".repeat(16_384));
    expect(Buffer.byteLength(buffer.read(), "utf8")).toBe(65_536);
    buffer.push("later");
    expect(buffer.read()).toBe("🙂".repeat(16_384));
  });
});

describe("assertStartupThenRelease (§9.1, §9.4)", () => {
  test("passes the collected output to the check, then releases", async () => {
    setStartupWaitMsForTests(0);
    try {
      const buffer = createStartupBuffer();
      buffer.push("› ready");
      await assertStartupThenRelease("claude", buffer, () => undefined);
      // Released after the check settled.
      expect(buffer.read()).toBe("");
    } finally {
      resetStartupWaitMsForTests();
    }
  });

  test("releases even when the startup check rejects (auth banner)", async () => {
    setStartupWaitMsForTests(0);
    try {
      const buffer = createStartupBuffer();
      buffer.push("Error: not authenticated");
      await expect(
        assertStartupThenRelease("codex", buffer, () => undefined),
      ).rejects.toMatchObject({ code: "codex_not_authenticated" });
      expect(buffer.read()).toBe("");
    } finally {
      resetStartupWaitMsForTests();
    }
  });
});
