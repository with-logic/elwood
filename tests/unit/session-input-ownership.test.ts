/** Private picker input views preserve terminal behavior and revoke only raw input (C-API-55). */
import { expect, test, vi } from "vitest";
import { stageComposer } from "../../src/core/input/composer-cleanup.ts";
import { bindStartupLifetime } from "../../src/runtime/session/frames.ts";
import { createReadinessGate } from "../../src/runtime/session/readiness.ts";
import {
  onCallerInput,
  SessionInputOwnership,
  withAutomatedInput,
} from "../../src/runtime/session/session-input.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

test("C-API-55 terminal observation and picker-owned writes preserve input authority", async () => {
  const writes: string[] = [];
  const inner = createHeadlessTerminal({ cols: 80, rows: 24 }, (input) =>
    writes.push(String(input)),
  );
  await withAutomatedInput(inner, () => inner.sendInput("startup"));
  writes.length = 0;
  const owner = new SessionInputOwnership(inner);
  const signal = owner.signal();
  const terminal = owner.caller;
  try {
    await terminal.writeOutput("\u001b]0;Picker title\u0007screen");
    terminal.resize({ cols: 90, rows: 30 });
    await terminal.settled();
    expect(terminal.size).toEqual({ cols: 90, rows: 30 });
    expect(terminal.title).toBe("Picker title");
    expect(terminal.snapshot().text).toContain("screen");
    expect(terminal.renderFailed).toBe(false);
    await owner.automated.sendInput("/model");
    expect(writes).toEqual(["/model"]);
    expect(signal.aborted).toBe(false);
    await terminal.sendInput("human");
    expect(signal.reason).toMatchObject({ code: "model_automation_failed" });
    const next = owner.signal();
    terminal.xterm.input("replacement");
    expect(next.aborted).toBe(true);
  } finally {
    terminal.dispose();
  }
});

test("C-API-55/56 native protocol replies preserve picker and staged cleanup authority", async () => {
  const writes: string[] = [];
  const inner = createHeadlessTerminal({ cols: 80, rows: 24 }, (input) =>
    writes.push(String(input)),
  );
  const owner = new SessionInputOwnership(inner);
  const signal = owner.signal();
  const closing = new AbortController();
  const acknowledgement = {};
  const run = owner.composerCleanup(
    () => false,
    closing.signal,
    () => {
      if (writes.at(-1) !== "\u0015\u000b") return undefined;
      return acknowledgement;
    },
  );
  try {
    // The real parser generates cursor-position and device-attribute replies, not caller input.
    await inner.writeOutput("\u001b[6n\u001b[c");
    await inner.settled();
    expect(writes).toHaveLength(2);
    expect(signal.aborted).toBe(false);
    await expect(
      run(() => {
        stageComposer(owner.automated);
        throw new Error("cancelled draft");
      }, closing.signal),
    ).rejects.toThrow("cancelled draft");
    expect(writes.at(-1)).toBe("\u0015\u000b");
    expect(signal.aborted).toBe(false);
  } finally {
    closing.abort();
    inner.dispose();
  }
});

test("C-TRUST-01 a closed session stops handing caller input to its startup prompts", () => {
  const inner = createHeadlessTerminal({ cols: 80, rows: 24 }, () => undefined);
  const owner = new SessionInputOwnership(inner);
  const other = vi.fn();
  const stopOther = onCallerInput(owner.caller, other);
  const trust = { inputBlocking: false, blockedPrompt: undefined, dispose: vi.fn() };
  const callerInput = vi.fn();
  const closing = new AbortController();
  const session = { closing, bindInitialReadinessHold: vi.fn(), terminal: owner.caller };
  try {
    bindStartupLifetime(session, { ...trust, callerInput }, createReadinessGate(vi.fn(), false));
    owner.caller.xterm.input("1");
    expect(callerInput).toHaveBeenCalledTimes(1);
    closing.abort();
    owner.caller.xterm.input("2");
    expect(callerInput).toHaveBeenCalledTimes(1); // the closed session's listener is gone
    expect(other).toHaveBeenCalledTimes(2); // and only that one
    stopOther();
    owner.caller.xterm.input("3");
    expect(other).toHaveBeenCalledTimes(2);
  } finally {
    inner.dispose();
  }
});

test("C-API-55 caller input sent from inside an automated write still revokes", async () => {
  const writes: string[] = [];
  const inner = createHeadlessTerminal({ cols: 80, rows: 24 }, (input) =>
    writes.push(String(input)),
  );
  const owner = new SessionInputOwnership(inner);
  const signal = owner.signal();
  const startupPrompts = vi.fn(); // a session's startup prompts hear caller input this way
  const stopStartupPrompts = onCallerInput(owner.caller, startupPrompts);
  // A host listener that types the moment it sees Elwood's key, inside that write.
  const listener = inner.xterm.onData((data) => {
    if (data === "/model") owner.caller.xterm.input("human");
  });
  try {
    let next: AbortSignal | undefined;
    await withAutomatedInput(inner, async () => {
      const typed = inner.sendInput("/model");
      expect(signal.reason).toMatchObject({ code: "model_automation_failed" });
      expect(startupPrompts).toHaveBeenCalledTimes(1);
      // Elwood's next write in this same scope, after the caller's keys, stays automated.
      next = owner.signal();
      await Promise.all([typed, inner.sendInput("x")]);
    });
    expect(next?.aborted).toBe(false);
    expect(startupPrompts).toHaveBeenCalledTimes(1);
    expect(writes).toEqual(["/model", "human", "x"]);
  } finally {
    stopStartupPrompts();
    listener.dispose();
    inner.dispose();
  }
});
