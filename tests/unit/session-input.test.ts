/**
 * Unit tests for prompt submission through the public `writeQueuedInput` surface: split
 * paste/Enter, staged nudges, dialog holds, and cancellation — under fake timers so the settle
 * (150ms), nudge (1s), and blocked-poll (50ms) windows are advanced explicitly. Paste
 * sanitization lives in `session-input-sanitize.test.ts`. Covers PRD §5.3 and C-API-31.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ignoreInputFailure,
  type PasteGuard,
  writeQueuedInput,
} from "../../src/core/input/index.ts";

function fakeTerminal(): { writes: string[]; sendInput: (d: string | Uint8Array) => void } {
  const writes: string[] = [];
  return { writes, sendInput: (d) => writes.push(String(d)) };
}

const paste = (text: string) => `[200~${text}[201~`;
const enters = (writes: readonly string[]) => writes.filter((w) => w === "\r").length;
/** Submit `prompt` as a pasted input; the promise is observed so a rejection is never unhandled. */
function submit(
  terminal: { sendInput: (d: string | Uint8Array) => void },
  prompt: string,
  guard?: PasteGuard,
  signal?: AbortSignal,
) {
  const pending = writeQueuedInput(terminal, prompt, "pasted_input", guard, signal);
  pending.catch(() => undefined);
  return pending;
}

describe("ignoreInputFailure", () => {
  test("best-effort input consumes asynchronous failures without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.once("unhandledRejection", unhandled);
    ignoreInputFailure(Promise.reject(new Error("ignored")));
    await new Promise((resolve) => setImmediate(resolve)); // the rejection would report here
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("writeQueuedInput pasted_input", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("C-API-31 the Enter is a separate keystroke after the paste settles", async () => {
    const terminal = fakeTerminal();
    const pending = submit(terminal, "hello");
    expect(terminal.writes).toEqual([paste("hello")]);
    await vi.advanceTimersByTimeAsync(150);
    await pending;
    expect(terminal.writes).toEqual([paste("hello"), "\r"]);
  });

  test("C-API-31 staged content triggers bounded re-Enter nudges", async () => {
    const terminal = fakeTerminal();
    const guard: PasteGuard = {
      snapshot: () => "> [Pasted text #1 +15 lines]",
      staged: (screen) => screen.includes("[Pasted text"),
    };
    await Promise.all([submit(terminal, "line1\nline2", guard), vi.advanceTimersByTimeAsync(150)]);
    await vi.runAllTimersAsync();
    // Initial Enter plus exactly pasteNudgeAttempts re-Enters, then stop.
    expect(enters(terminal.writes)).toBe(3);
  });

  test("C-API-31 an aborted signal stops recovery nudges so they cannot hit a later paste", async () => {
    const terminal = fakeTerminal();
    const guard: PasteGuard = {
      snapshot: () => "> [Pasted text #1]",
      staged: (screen) => screen.includes("[Pasted text"),
    };
    const controller = new AbortController();
    await Promise.all([
      submit(terminal, "old", guard, controller.signal),
      vi.advanceTimersByTimeAsync(150),
    ]);
    // The next submission begins after this prompt committed: aborting must halt
    // its background nudges even though its staged chip is still on screen.
    controller.abort();
    await vi.runAllTimersAsync();
    // Only the first submitting Enter landed; no background nudge fired.
    expect(enters(terminal.writes)).toBe(1);
  });

  test("C-LOOP-17 cancellation after paste clears the composer before the first Enter", async () => {
    const terminal = fakeTerminal();
    const controller = new AbortController();
    const submitted = submit(terminal, "scheduled", undefined, controller.signal);
    expect(terminal.writes).toEqual([paste("scheduled")]);
    controller.abort(new Error("cancelled"));
    await expect(submitted).rejects.toThrow("cancelled");
    expect(terminal.writes).toEqual([paste("scheduled"), ""]);
    expect(terminal.writes).not.toContain("\r");
  });

  test("C-LOOP-17 cancellation while a dialog blocks writes no prompt", async () => {
    const terminal = fakeTerminal();
    const controller = new AbortController();
    const guard: PasteGuard = { snapshot: () => "", staged: () => false, blocked: () => true };
    const submitted = submit(terminal, "scheduled", guard, controller.signal);
    controller.abort(new Error("cancelled while blocked"));
    await vi.advanceTimersByTimeAsync(50); // the blocked-poll tick observes the abort
    await expect(submitted).rejects.toThrow("cancelled while blocked");
    expect(terminal.writes).toEqual([]);
  });

  test("C-API-31 a submitted prompt is never nudged", async () => {
    const terminal = fakeTerminal();
    const guard: PasteGuard = {
      snapshot: () => "> ",
      staged: (screen) => screen.includes("[Pasted text"),
    };
    await Promise.all([submit(terminal, "hello", guard), vi.advanceTimersByTimeAsync(150)]);
    await vi.runAllTimersAsync();
    expect(enters(terminal.writes)).toBe(1);
  });

  test("C-API-07 C-API-37 a failed first Enter rejects submission", async () => {
    const writes: string[] = [];
    const terminal = {
      sendInput: (d: string | Uint8Array) => {
        if (d === "\r") throw new Error("terminal disposed");
        writes.push(String(d));
      },
    };
    const submitted = submit(terminal, "hello");
    await vi.runAllTimersAsync();
    await expect(submitted).rejects.toThrow("terminal disposed");
    expect(writes).toEqual([paste("hello")]);
  });

  test("C-API-37 the WHOLE submission (paste included) is held while a dialog blocks", async () => {
    const terminal = fakeTerminal();
    let blocked = true;
    const guard: PasteGuard = { snapshot: () => "> ", staged: () => false, blocked: () => blocked };
    // A dialog is on screen from the start: NOT EVEN the paste may be written into
    // it (its bytes could be interpreted as shortcuts). Stay blocked across several
    // 50ms re-polls before clearing.
    const submitted = submit(terminal, "hello", guard);
    await vi.advanceTimersByTimeAsync(140);
    expect(terminal.writes).toEqual([]);
    // Once the dialog clears, the paste and its submitting Enter both land.
    blocked = false;
    await vi.advanceTimersByTimeAsync(50 + 150);
    await submitted;
    expect(terminal.writes).toEqual([paste("hello"), "\r"]);
  });

  test("C-API-37 a recovery nudge is also skipped while blocked", async () => {
    const terminal = fakeTerminal();
    let blocked = false;
    const guard: PasteGuard = {
      snapshot: () => "> [Pasted text #1]",
      staged: (screen) => screen.includes("[Pasted text"),
      blocked: () => blocked,
    };
    await Promise.all([submit(terminal, "line1\nline2", guard), vi.advanceTimersByTimeAsync(150)]);
    // First Enter fired (not blocked); now a dialog appears before the nudge.
    blocked = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(enters(terminal.writes)).toBe(1); // the nudge was skipped, not fired into the dialog
    blocked = false;
    await vi.advanceTimersByTimeAsync(1_000);
    // The nudge that was skipped while blocked resumes once the dialog clears.
    expect(enters(terminal.writes)).toBe(2);
  });

  test("C-API-31 later recovery Enter failures remain best-effort", async () => {
    let count = 0;
    const terminal = {
      sendInput: (data: string | Uint8Array) => {
        if (data !== "\r") return;
        count += 1;
        if (count > 1) throw new Error("terminal disposed");
      },
    };
    const guard: PasteGuard = { snapshot: () => "[Pasted text", staged: () => true };
    const submitted = submit(terminal, "hello", guard);
    await vi.advanceTimersByTimeAsync(150);
    await expect(submitted).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    expect(count).toBeGreaterThan(1);
  });

  test("C-API-40 the written paste of hostile text carries no payload control bytes", () => {
    const terminal = fakeTerminal();
    void submit(terminal, "x[201~\ry");
    // Only the two framing ESCs Elwood itself adds remain; none from the payload.
    expect(terminal.writes[0]).toBe(paste("x[201~\ry"));
  });
});
