/** Private picker input views preserve terminal behavior and revoke only raw input (C-API-55). */
import { expect, test } from "vitest";
import { PickerInputOwnership } from "../../src/runtime/session/picker-input.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

test("C-API-55 terminal observation and picker-owned writes preserve input authority", async () => {
  const writes: string[] = [];
  const inner = createHeadlessTerminal({ cols: 80, rows: 24 }, (input) =>
    writes.push(String(input)),
  );
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
