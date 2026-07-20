/**
 * Hermetic coverage for the Codex clipboard helpers (PRD §5.3, C-API-46). The
 * process boundary (osascript/pbpaste/pbcopy) is stubbed so the default suite
 * never mutates the real macOS clipboard (which would flake under parallel test
 * files); the real NSPasteboard round-trip is exercised by the serial e2e.
 */

import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";

// `error` is `unknown` on purpose: these tests exercise arbitrary rejection
// values (strings, objects with stderr, plain messages), matching what a real
// process failure can surface — no cast is needed to install them.
type ExecResult = { stdout?: string; error?: unknown };
const results: { value: ExecResult } = { value: { stdout: "" } };
const calls: { file: string; args: readonly string[] }[] = [];

// A fake execFile with the custom-promisify behavior of the real one: the
// promisified form resolves to `{ stdout, stderr }` and carries a `.child` with a
// stdin sink (for pbcopy input). Rejections carry the error just like the real API.
function fakeExecFile(file: string, args: readonly string[]) {
  calls.push({ file, args });
  const { value } = results;
  const child = { stdin: { end: () => undefined } };
  const promise = value.error
    ? Promise.reject(value.error)
    : Promise.resolve({ stdout: value.stdout ?? "", stderr: "" });
  return Object.assign(promise, { child });
}
(fakeExecFile as unknown as Record<symbol, unknown>)[promisify.custom] = fakeExecFile;

vi.mock("node:child_process", () => ({ execFile: fakeExecFile }));

const { clipboardImageSupported, restoreClipboardText, setClipboardImage, snapshotClipboardText } =
  await import("../../src/codex/clipboard.ts");

afterEach(() => {
  results.value = { stdout: "" };
  calls.length = 0;
});

describe("Codex clipboard helpers (C-API-46)", () => {
  test("C-API-46 clipboardImageSupported is true only on macOS", () => {
    expect(clipboardImageSupported()).toBe(process.platform === "darwin");
  });

  test("C-API-46 snapshot returns clipboard text", async () => {
    results.value = { stdout: "prior text" };
    await expect(snapshotClipboardText()).resolves.toBe("prior text");
  });

  test("C-API-46 snapshot rejects with image_attach_failed when pbpaste fails", async () => {
    results.value = { error: new Error("pbpaste boom") };
    await expect(snapshotClipboardText()).rejects.toMatchObject({ code: "image_attach_failed" });
    // A non-Error rejection is stringified into the cause, not dropped.
    results.value = { error: "raw-string" };
    await expect(snapshotClipboardText()).rejects.toMatchObject({ code: "image_attach_failed" });
  });

  test("C-API-46 setClipboardImage runs osascript JXA and resolves on success", async () => {
    results.value = { stdout: "ok" };
    await expect(setClipboardImage("/abs/a.png")).resolves.toBeUndefined();
    expect(calls.at(-1)?.args).toContain("/abs/a.png");
  });

  test("C-API-46 setClipboardImage maps a decode failure to invalid_image", async () => {
    // The JXA throws "image load failed" only when NSImage cannot decode the file.
    results.value = { error: Object.assign(new Error("x"), { stderr: "image load failed" }) };
    await expect(setClipboardImage("/abs/a.png")).rejects.toMatchObject({ code: "invalid_image" });
  });

  test("C-API-46 setClipboardImage maps a write/process failure to image_attach_failed", async () => {
    results.value = { error: Object.assign(new Error("x"), { stderr: "clipboard write failed" }) };
    await expect(setClipboardImage("/abs/a.png")).rejects.toMatchObject({
      code: "image_attach_failed",
    });
  });

  test("C-API-46 setClipboardImage falls back to message then a generic reason", async () => {
    results.value = { error: new Error("only-message") };
    await expect(setClipboardImage("/x.png")).rejects.toThrow(/only-message/);
    // Neither stderr nor a message → the generic fallback reason.
    results.value = { error: { stderr: "", message: "" } };
    await expect(setClipboardImage("/x.png")).rejects.toThrow(/clipboard image write failed/);
  });

  test("C-API-46 restore returns true on success and false on failure (never rejects)", async () => {
    results.value = { stdout: "" };
    await expect(restoreClipboardText("text")).resolves.toBe(true);
    results.value = { error: new Error("pbcopy boom") };
    await expect(restoreClipboardText("text")).resolves.toBe(false);
  });

  test("C-API-46 setClipboardImage uses the generic reason for a non-object error", async () => {
    results.value = { error: "string-error" };
    await expect(setClipboardImage("/x.png")).rejects.toThrow(/clipboard image write failed/);
  });
});
