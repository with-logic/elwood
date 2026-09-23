/** Raw edits revoke automated recovery Enter authority (PRD §5.3, C-API-56). */
import { afterEach, expect, test, vi } from "vitest";
import { writeQueuedInput } from "../../src/core/input/index.ts";
import { PickerInputOwnership } from "../../src/runtime/session/picker-input.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test.each([
  { raw: "sendInput", queueSignal: true, duringObservation: false },
  { raw: "xterm", queueSignal: true, duringObservation: false },
  { raw: "sendInput", queueSignal: false, duringObservation: false },
  { raw: "sendInput", queueSignal: true, duringObservation: true },
  { raw: "none", queueSignal: true, duringObservation: false },
] as const)("C-API-56 recovery follows $raw ownership (queue=$queueSignal, observing=$duringObservation)", async ({
  raw,
  queueSignal,
  duringObservation,
}) => {
  const writes: string[] = [];
  const observation = Promise.withResolvers<void>();
  const terminal = createHeadlessTerminal({ cols: 100, rows: 30 }, (input) =>
    writes.push(String(input)),
  );
  const ownership = new PickerInputOwnership(terminal);
  const closing = new AbortController();
  ownership.composerCleanup(
    () => false,
    closing.signal,
    () => undefined,
  );
  await terminal.writeOutput("");
  vi.useFakeTimers();
  const pending = writeQueuedInput(
    ownership.automated,
    "replay",
    "pasted_input",
    {
      snapshot: () => "[Image #1] caller-edited draft",
      // An attachment marker remains staged after a caller edits the accompanying text.
      staged: () => true,
    },
    queueSignal ? closing.signal : undefined,
  ).catch((error: unknown) => error);
  try {
    await vi.advanceTimersByTimeAsync(150);
    expect(writes.filter((value) => value === "\r")).toHaveLength(1);
    if (duringObservation) {
      vi.spyOn(ownership.automated, "settled").mockReturnValueOnce(observation.promise);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    if (raw === "sendInput") await ownership.caller.sendInput("caller edit");
    else if (raw === "xterm") ownership.caller.xterm.input("caller edit");
    observation.resolve();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(writes.filter((value) => value === "\r")).toHaveLength(raw === "none" ? 3 : 1);
    expect(writes).not.toContain("\u0015\u000b");
  } finally {
    closing.abort();
    observation.resolve();
    await vi.runAllTimersAsync();
    await pending;
    terminal.dispose();
  }
});
