/** Native evidence captured before Enter survives asynchronous dispatch (C-API-31). */
import { afterEach, expect, test, vi } from "vitest";
import { writeQueuedInput } from "../../src/core/input/index.ts";
import type { ElwoodCommonEventMap } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { NativePasteRecovery } from "../../src/runtime/session/paste-recovery.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

afterEach(() => vi.useRealTimers());

test("C-API-31 accepted hook during pending Enter permanently revokes recovery", async () => {
  vi.useFakeTimers();
  const terminal = createHeadlessTerminal({ cols: 80, rows: 24 }, () => undefined);
  const events = new TypedEmitter<ElwoodCommonEventMap>();
  const closing = new AbortController();
  const recovery = new NativePasteRecovery(terminal, events, closing.signal);
  const dispatched = Promise.withResolvers<void>();
  const writes: string[] = [];
  const input = {
    sendInput(value: string | Uint8Array) {
      writes.push(String(value));
      if (value === "\r") return dispatched.promise;
      return undefined;
    },
  };
  try {
    const sent = writeQueuedInput(input, "draft", "pasted_input", {
      snapshot: () => "draft",
      staged: () => true,
      recovery: () => recovery.capture(),
    });
    await vi.advanceTimersByTimeAsync(150);
    events.emit("activity", {
      agent: "claude",
      elwoodSessionId: "s",
      source: "hook",
      kind: "user_message",
      label: "user",
    });
    dispatched.resolve();
    await sent;
    const painted = terminal.writeOutput("new idle draft frame");
    await vi.advanceTimersByTimeAsync(1);
    await painted;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(writes).toEqual(["\u001b[200~draft\u001b[201~", "\r"]);
    recovery.observeWorking(true);
    const active = recovery.capture();
    recovery.observeWorking(false);
    expect(active.revoked()).toBe(true);
  } finally {
    closing.abort();
    dispatched.resolve();
    terminal.dispose();
  }
});

test.each([
  "abort",
  "missing",
  "fresh",
] as const)("C-API-31 recovery observes %s evidence after first Enter", async (mode) => {
  vi.useFakeTimers();
  let frame: object | undefined = {};
  const abort = new AbortController();
  const writes: string[] = [];
  const sent = writeQueuedInput(
    {
      sendInput: (value) => {
        writes.push(String(value));
      },
    },
    "draft",
    "pasted_input",
    {
      snapshot: () => "draft",
      staged: () => true,
      recovery: () => ({ revoked: () => false, frame: () => frame }),
    },
    abort.signal,
  );
  await vi.advanceTimersByTimeAsync(150);
  await sent;
  if (mode === "abort") abort.abort();
  frame = mode === "missing" ? undefined : {};
  await vi.advanceTimersByTimeAsync(1_000);
  expect(writes.filter((value) => value === "\r")).toHaveLength(mode === "fresh" ? 2 : 1);
  // The next retry also needs a frame newer than its own preceding Enter.
  await vi.advanceTimersByTimeAsync(3_000);
  expect(writes.filter((value) => value === "\r")).toHaveLength(mode === "fresh" ? 2 : 1);
});
