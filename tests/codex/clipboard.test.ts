/**
 * Hermetic coverage for the Codex clipboard helpers (PRD §5.3, C-API-46). The
 * process boundary (osascript/pbpaste/pbcopy) is stubbed so the default suite
 * never mutates the real macOS clipboard (which would flake under parallel test
 * files); the real NSPasteboard round-trip is exercised by the serial e2e.
 */

import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";

type ExecResult = { stdout?: string; error?: Error };
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
    results.value = { error: "raw-string" as unknown as Error };
    await expect(snapshotClipboardText()).rejects.toMatchObject({ code: "image_attach_failed" });
  });

  test("C-API-46 setClipboardImage runs osascript JXA and resolves on success", async () => {
    results.value = { stdout: "ok" };
    await expect(setClipboardImage("/abs/a.png")).resolves.toBeUndefined();
    expect(calls.at(-1)?.args).toContain("/abs/a.png");
  });

  test("C-API-46 setClipboardImage rejects with invalid_image on failure", async () => {
    results.value = { error: Object.assign(new Error("boom"), { stderr: "bad image" }) };
    await expect(setClipboardImage("/abs/a.png")).rejects.toMatchObject({ code: "invalid_image" });
  });

  test("C-API-46 setClipboardImage falls back to message then a generic reason", async () => {
    results.value = { error: new Error("only-message") };
    await expect(setClipboardImage("/x.png")).rejects.toThrow(/only-message/);
    // Neither stderr nor a message → the generic fallback reason.
    results.value = { error: { stderr: "", message: "" } as unknown as Error };
    await expect(setClipboardImage("/x.png")).rejects.toThrow(/clipboard image write failed/);
  });

  test("C-API-46 restore resolves on success and never rejects on failure", async () => {
    results.value = { stdout: "" };
    await expect(restoreClipboardText("text")).resolves.toBeUndefined();
    results.value = { error: new Error("pbcopy boom") };
    await expect(restoreClipboardText("text")).resolves.toBeUndefined();
  });

  test("C-API-46 setClipboardImage uses the generic reason for a non-object error", async () => {
    results.value = { error: "string-error" as unknown as Error };
    await expect(setClipboardImage("/x.png")).rejects.toThrow(/clipboard image write failed/);
  });
});
