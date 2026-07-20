/**
 * Process-boundary branch coverage for the clipboard helpers (PRD §5.3,
 * C-API-46): the stdout-absent path and the stderr → error.message → fallback
 * chain don't reliably occur on a healthy mac, so a stubbed spawnSync exercises
 * them. The real NSPasteboard round-trip lives in images-clipboard.test.ts.
 */

import { describe, expect, test, vi } from "vitest";

const spawnResult: { value: Record<string, unknown> } = { value: {} };
vi.mock("node:child_process", () => ({
  spawnSync: () => spawnResult.value,
}));

const { setClipboardImage, snapshotClipboardText } = await import(
  "../../src/core/images/clipboard.ts"
);

describe("clipboard boundary branches (C-API-46)", () => {
  test("C-API-46 snapshot returns empty string when stdout is absent", () => {
    spawnResult.value = { stdout: null };
    expect(snapshotClipboardText()).toBe("");
  });

  test("C-API-46 snapshot returns the stdout string when present", () => {
    spawnResult.value = { stdout: "clip-text" };
    expect(snapshotClipboardText()).toBe("clip-text");
  });

  test("C-API-46 setClipboardImage surfaces stderr, then error.message, then a fallback", () => {
    spawnResult.value = { status: 1, stderr: "explode" };
    expect(() => setClipboardImage("/x.png")).toThrow(/explode/);
    spawnResult.value = { status: 1, stderr: "", error: { message: "spawn failed" } };
    expect(() => setClipboardImage("/x.png")).toThrow(/spawn failed/);
    spawnResult.value = { status: 1, stderr: "" };
    expect(() => setClipboardImage("/x.png")).toThrow(/clipboard image write failed/);
  });

  test("C-API-46 setClipboardImage succeeds silently on status 0", () => {
    spawnResult.value = { status: 0 };
    expect(() => setClipboardImage("/x.png")).not.toThrow();
  });
});
