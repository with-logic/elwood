/**
 * Unit tests for prompt submission: split paste/Enter and staged nudges.
 * Covers PRD §5.3 and C-API-31.
 */

import { describe, expect, test } from "vitest";
import {
  ignoreInputFailure,
  type PasteGuard,
  writePastedPrompt,
} from "../../src/core/session-input.ts";

function fakeTerminal(): { writes: string[]; sendInput: (d: string | Uint8Array) => void } {
  const writes: string[] = [];
  return { writes, sendInput: (d) => writes.push(String(d)) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;

describe("writePastedPrompt", () => {
  test("best-effort input consumes asynchronous failures", async () => {
    ignoreInputFailure(Promise.reject(new Error("ignored")));
    await sleep(0);
  });
  test("C-API-31 the Enter is a separate keystroke after the paste settles", async () => {
    const terminal = fakeTerminal();
    writePastedPrompt(terminal, "hello", undefined, 5, 5);
    expect(terminal.writes).toEqual([paste("hello")]);
    await sleep(15);
    expect(terminal.writes).toEqual([paste("hello"), "\r"]);
  });

  test("C-API-31 staged content triggers bounded re-Enter nudges", async () => {
    const terminal = fakeTerminal();
    const guard: PasteGuard = {
      snapshot: () => "> [Pasted text #1 +15 lines]",
      staged: (screen) => screen.includes("[Pasted text"),
    };
    writePastedPrompt(terminal, "line1\nline2", guard, 5, 5);
    await sleep(40);
    // Initial Enter plus exactly pasteNudgeAttempts re-Enters, then stop.
    expect(terminal.writes.filter((w) => w === "\r")).toHaveLength(3);
  });

  test("C-API-31 a submitted prompt is never nudged", async () => {
    const terminal = fakeTerminal();
    const guard: PasteGuard = {
      snapshot: () => "> ",
      staged: (screen) => screen.includes("[Pasted text"),
    };
    writePastedPrompt(terminal, "hello", guard, 5, 5);
    await sleep(30);
    expect(terminal.writes.filter((w) => w === "\r")).toHaveLength(1);
  });

  test("C-API-07 C-API-37 a failed first Enter rejects submission", async () => {
    const writes: string[] = [];
    const terminal = {
      sendInput: (d: string | Uint8Array) => {
        if (d === "\r") throw new Error("terminal disposed");
        writes.push(String(d));
      },
    };
    await expect(writePastedPrompt(terminal, "hello", undefined, 1, 1)).rejects.toThrow(
      "terminal disposed",
    );
    expect(writes).toEqual([paste("hello")]);
  });

  test("C-API-31 later recovery Enter failures remain best-effort", async () => {
    let enters = 0;
    const terminal = {
      sendInput: (data: string | Uint8Array) => {
        if (data !== "\r") return;
        enters += 1;
        if (enters > 1) throw new Error("terminal disposed");
      },
    };
    const guard: PasteGuard = { snapshot: () => "[Pasted text", staged: () => true };
    await expect(writePastedPrompt(terminal, "hello", guard, 1, 1)).resolves.toBeUndefined();
    await sleep(10);
    expect(enters).toBeGreaterThan(1);
  });
});
