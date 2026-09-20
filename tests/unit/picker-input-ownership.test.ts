/** Private picker input views preserve terminal behavior and revoke only raw input (C-API-55). */
import { expect, test } from "vitest";
import { stageComposer } from "../../src/core/input/composer-cleanup.ts";
import {
  PickerInputOwnership,
  withAutomatedInput,
} from "../../src/runtime/session/picker-input.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

test("C-API-55 terminal observation and picker-owned writes preserve input authority", async () => {
  const writes: string[] = [];
  const inner = createHeadlessTerminal({ cols: 80, rows: 24 }, (input) =>
    writes.push(String(input)),
  );
  await withAutomatedInput(inner, () => inner.sendInput("startup"));
  writes.length = 0;
  const owner = new PickerInputOwnership(inner);
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
  const owner = new PickerInputOwnership(inner);
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
