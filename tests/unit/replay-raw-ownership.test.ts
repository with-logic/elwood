/** Raw edits revoke automated recovery Enter authority (PRD §5.3, C-API-56). */
import { afterEach, expect, test, vi } from "vitest";
import { writeQueuedInput } from "../../src/core/input/index.ts";
import { PickerInputOwnership } from "../../src/runtime/session/picker-input.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

afterEach(() => vi.useRealTimers());

test.each([
  "sendInput",
  "xterm",
] as const)("C-API-56 %s raw edits stop replay recovery Enters", async (raw) => {
  const writes: string[] = [];
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
    "turn_replay_input",
    {
      snapshot: () => "[Image #1] caller-edited draft",
      // An attachment marker remains staged after a caller edits the accompanying text.
      staged: () => true,
    },
    closing.signal,
  ).catch((error: unknown) => error);
  try {
    await vi.advanceTimersByTimeAsync(150);
    expect(writes.filter((value) => value === "\r")).toHaveLength(1);
    if (raw === "sendInput") await ownership.caller.sendInput("caller edit");
    else ownership.caller.xterm.input("caller edit");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(writes.filter((value) => value === "\r")).toHaveLength(1);
    expect(writes).not.toContain("\u0015\u000b");
    expect(await pending).toMatchObject({ code: "wait_timeout" });
  } finally {
    closing.abort();
    await vi.runAllTimersAsync();
    await pending;
    terminal.dispose();
  }
});
