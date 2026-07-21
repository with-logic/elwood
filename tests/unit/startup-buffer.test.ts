/**
 * Unit tests for the bounded, release-able startup output collector.
 * Covers PRD §9.1 startup usability and §9.4 resource cleanup: the collector
 * bounds early output, stops appending once released, and clears its retained
 * string so no per-session transcript lingers for the PTY handler's lifetime.
 */

import { describe, expect, test } from "vitest";
import { resetStartupWaitMsForTests, setStartupWaitMsForTests } from "../../src/runtime/startup.ts";
import { assertStartupThenRelease, createStartupBuffer } from "../../src/runtime/startup-buffer.ts";

describe("createStartupBuffer (§9.1, §9.4)", () => {
  test("collects chunks until read", () => {
    const buffer = createStartupBuffer();
    buffer.push("hello ");
    buffer.push("world");
    expect(buffer.read()).toBe("hello world");
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
    const buffer = createStartupBuffer(8);
    buffer.push("1234");
    buffer.push("5678ABCD");
    // First push filled it to 4, the second is truncated at the 8-byte cap.
    expect(buffer.read()).toBe("12345678");
    // Once at the cap, further chunks are ignored.
    buffer.push("more");
    expect(buffer.read()).toBe("12345678");
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
