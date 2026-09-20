/**
 * A synchronous `pbcopy` spawn throw still reports a failed restore (PRD §5.3,
 * C-API-46). The throw is REAL: the restore launch is redirected to a harmless
 * binary with an environment too large to exec, so `spawn` throws `E2BIG`
 * synchronously and the user's clipboard is never touched.
 */

import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import type { AttachTerminal } from "../../src/core/images/chip-wait.ts";

const state = { syncThrows: 0, calls: [] as string[] };

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const run = promisify(actual.execFile);
  function execFile(file: string) {
    state.calls.push(file.slice(file.lastIndexOf("/") + 1));
    if (!file.endsWith("pbcopy")) return Promise.resolve({ stdout: "prior", stderr: "" });
    try {
      return run(process.execPath, ["-e", ""], { env: { HUGE: "x".repeat(8 * 1024 * 1024) } });
    } catch (error) {
      state.syncThrows++;
      throw error;
    }
  }
  Object.defineProperty(execFile, promisify.custom, { value: execFile, configurable: true });
  return { ...actual, execFile };
});

const { attachCodexImages } = await import("../../src/codex/images/attach.ts");
const { restoreClipboardText } = await import("../../src/codex/images/clipboard.ts");
const { resetRuntimeSeamsForTests, setPlatformForTests } = await import(
  "../../src/runtime/seams.ts"
);

afterEach(() => {
  resetRuntimeSeamsForTests();
  state.syncThrows = 0;
  state.calls.length = 0;
});

test("C-API-46 a synchronous pbcopy spawn throw resolves the restore as failed", async () => {
  await expect(restoreClipboardText("prior")).resolves.toBe(false);
  expect(state.syncThrows).toBe(1); // the spawn really threw before any child existed
});

test("C-API-46 an attach whose restore cannot spawn still warns and frees the clipboard lock", async () => {
  setPlatformForTests("darwin");
  let pasted = false;
  const terminal: AttachTerminal = {
    settled: () => Promise.resolve(),
    renderFailed: false,
    sendInput() {
      pasted = true;
    },
    snapshot: () => ({ text: pasted ? "› [Image #1]" : "› " }),
  };
  let warned = 0;
  const attach = () =>
    attachCodexImages(terminal, ["/shot.png"], new AbortController().signal, undefined, () => {
      warned++;
    });
  await expect(attach()).resolves.toBeUndefined();
  expect(state.syncThrows).toBe(1);
  expect(warned).toBe(1);
  pasted = false;
  await expect(attach()).resolves.toBeUndefined(); // the lock was released
  expect(state.calls).toEqual(["pbpaste", "osascript", "pbcopy", "pbpaste", "osascript", "pbcopy"]);
});
