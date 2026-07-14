/**
 * Unit tests for prompt submission: split paste/Enter and staged nudges.
 * Covers PRD §5.3 and C-API-31.
 */

import { describe, expect, test } from "vitest";
import {
  ignoreInputFailure,
  type PasteGuard,
  sanitizePasteText,
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
    writePastedPrompt(terminal, "hello", undefined, undefined, 5, 5);
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
    writePastedPrompt(terminal, "line1\nline2", guard, undefined, 5, 5);
    await sleep(40);
    // Initial Enter plus exactly pasteNudgeAttempts re-Enters, then stop.
    expect(terminal.writes.filter((w) => w === "\r")).toHaveLength(3);
  });

  test("C-API-31 an aborted signal stops recovery nudges so they cannot hit a later paste", async () => {
    const terminal = fakeTerminal();
    const guard: PasteGuard = {
      snapshot: () => "> [Pasted text #1]",
      staged: (screen) => screen.includes("[Pasted text"),
    };
    const controller = new AbortController();
    writePastedPrompt(terminal, "old", guard, controller.signal, 5, 5);
    // The next submission begins: aborting must halt this prompt's nudges even
    // though its staged chip is still on screen.
    controller.abort();
    await sleep(40);
    // Only the first submitting Enter landed; no background nudge fired.
    expect(terminal.writes.filter((w) => w === "\r")).toHaveLength(1);
  });

  test("C-API-31 a submitted prompt is never nudged", async () => {
    const terminal = fakeTerminal();
    const guard: PasteGuard = {
      snapshot: () => "> ",
      staged: (screen) => screen.includes("[Pasted text"),
    };
    writePastedPrompt(terminal, "hello", guard, undefined, 5, 5);
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
    await expect(writePastedPrompt(terminal, "hello", undefined, undefined, 1, 1)).rejects.toThrow(
      "terminal disposed",
    );
    expect(writes).toEqual([paste("hello")]);
  });

  test("C-API-37 the submitting Enter is held across poll ticks until the dialog clears", async () => {
    const terminal = fakeTerminal();
    let blocked = true;
    const guard: PasteGuard = {
      snapshot: () => "> ",
      staged: () => false,
      blocked: () => blocked,
    };
    // Paste lands, but the settle-delayed Enter must NOT fire while blocked: it
    // would confirm the dialog instead of submitting the staged paste. Stay
    // blocked long enough that the guard re-polls at least once (blockedPollMs
    // is 50ms) before the dialog clears.
    const submitted = writePastedPrompt(terminal, "hello", guard, undefined, 5, 5);
    await sleep(140);
    expect(terminal.writes).toEqual([paste("hello")]);
    // Once the dialog clears, a later poll fires the held Enter and resolves.
    blocked = false;
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
    await writePastedPrompt(terminal, "line1\nline2", guard, undefined, 5, 5);
    // First Enter fired (not blocked); now a dialog appears before the nudge.
    blocked = true;
    await sleep(30);
    const entersWhileBlocked = terminal.writes.filter((w) => w === "\r").length;
    blocked = false;
    await sleep(20);
    // The nudge that was skipped while blocked resumes once the dialog clears.
    expect(terminal.writes.filter((w) => w === "\r").length).toBeGreaterThan(entersWhileBlocked);
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
    await expect(
      writePastedPrompt(terminal, "hello", guard, undefined, 1, 1),
    ).resolves.toBeUndefined();
    await sleep(10);
    expect(enters).toBeGreaterThan(1);
  });
});

describe("sanitizePasteText", () => {
  test("C-API-40 strips an embedded bracketed-paste end sentinel so it cannot escape paste mode", () => {
    // A message with ESC[201~ then a live Enter would otherwise end the paste
    // early and submit into a dialog; the ESC is removed, leaving inert text.
    const evil = "approve?[201~\rmalicious";
    const clean = sanitizePasteText(evil);
    // The ESC is gone, so the sentinel can no longer terminate paste mode; the
    // now-inert "[201~" text and the carriage return remain paste DATA.
    expect(clean.includes("")).toBe(false);
    expect(clean).toBe("approve?[201~\rmalicious");
  });

  test("C-API-40 preserves tab, newline, and carriage return as multi-line text", () => {
    expect(sanitizePasteText("a\tb\nc")).toBe("a\tb\nc");
  });

  test("C-API-40 strips other C0/C1 control bytes", () => {
    expect(sanitizePasteText("ab")).toBe("ab");
  });

  test("C-API-40 the written paste of hostile text carries no payload control bytes", () => {
    const terminal = fakeTerminal();
    writePastedPrompt(terminal, "x[201~\ry", undefined, undefined, 5, 5);
    // Only the two framing ESCs Elwood itself adds remain; none from the payload.
    expect(terminal.writes[0]).toBe(paste("x[201~\ry"));
  });
});
