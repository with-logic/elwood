/**
 * Concurrent Codex attaches retain the real clipboard mutex until a failed restore
 * child settles (PRD §5.3, C-API-46). Only OS clipboard process launches are replaced.
 */

import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import type { AttachTerminal } from "../../src/core/images/chip-wait.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";

const privateClipboard = `PRIVATE_CLIPBOARD_MARKER:${"x".repeat(1024 * 1024)}`;
const calls: string[] = [];
const state = {
  restores: 0,
  firstChild: undefined as ChildProcess | undefined,
  stdinFailed: false,
  childExited: false,
};

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const run = promisify(actual.execFile);
  function execFile(file: string, args: readonly string[]) {
    if (file.endsWith("pbpaste")) {
      calls.push("snapshot");
      return Promise.resolve({ stdout: privateClipboard, stderr: "" });
    }
    if (file.endsWith("osascript")) {
      calls.push(`set:${args.at(-1)}`);
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    calls.push("restore");
    const first = state.restores++ === 0;
    const child = run(process.execPath, [
      "-e",
      first
        ? "require('node:fs').closeSync(0); setInterval(() => {}, 1000);"
        : "process.stdin.resume();",
    ]);
    if (first) {
      state.firstChild = child.child;
      child.child.stdin!.once("error", () => {
        state.stdinFailed = true;
      });
      child.child.once("exit", () => {
        state.childExited = true;
        calls.push("first-child-exit");
      });
    }
    return child;
  }
  Object.defineProperty(execFile, promisify.custom, { value: execFile, configurable: true });
  return { ...actual, execFile };
});

const { attachCodexImages } = await import("../../src/codex/images/attach.ts");
const { clipboardRestoreFailedWarning } = await import("../../src/codex/session/warnings.ts");
const { resetRuntimeSeamsForTests, setPlatformForTests } = await import(
  "../../src/runtime/seams.ts"
);

afterEach(resetRuntimeSeamsForTests);

function terminal(): AttachTerminal {
  let pasted = false;
  return {
    sendInput() {
      pasted = true;
    },
    snapshot: () => ({ text: pasted ? "› [Image #1]" : "› " }),
  };
}

test("C-API-46 a failed restore owns the clipboard until its child exits before a competing attach", async () => {
  setPlatformForTests("darwin");
  const warnings: ElwoodWarningEvent[] = [];
  let firstDone = false;
  let secondDone = false;
  const attach = (id: string) =>
    attachCodexImages(terminal(), [`/${id}.png`], new AbortController().signal, undefined, () => {
      warnings.push(clipboardRestoreFailedWarning(id));
    });
  const first = attach("first").then(() => {
    firstDone = true;
  });
  const second = attach("second").then(() => {
    secondDone = true;
  });
  try {
    await vi.waitFor(() => expect(state.stdinFailed).toBe(true), { timeout: 5000 });
    // Let failure continuations run: an early lock release would now admit the second snapshot.
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.childExited).toBe(false);
    expect(firstDone).toBe(false);
    expect(secondDone).toBe(false);
    expect(calls).toEqual(["snapshot", "set:/first.png", "restore"]);
    expect(warnings).toEqual([]);

    expect(state.firstChild!.kill("SIGTERM")).toBe(true);
    await Promise.all([first, second]);
    expect(state.childExited).toBe(true);
    expect(firstDone).toBe(true);
    expect(secondDone).toBe(true);
    expect(calls).toEqual([
      "snapshot",
      "set:/first.png",
      "restore",
      "first-child-exit",
      "snapshot",
      "set:/second.png",
      "restore",
    ]);
    expect(warnings).toEqual([clipboardRestoreFailedWarning("first")]);
    expect(warnings[0]?.raw).toBe("clipboard_restore_failed");
    expect(JSON.stringify(warnings)).not.toContain("PRIVATE_CLIPBOARD_MARKER");
    expect(JSON.stringify(warnings)).not.toContain("/first.png");
  } finally {
    state.firstChild?.kill("SIGTERM");
    await Promise.allSettled([first, second]);
  }
});
