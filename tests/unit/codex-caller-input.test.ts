/** The session-facing terminal reports caller input and otherwise delegates (C-API-14). */
import { expect, test, vi } from "vitest";
import { reportCallerInput } from "../../src/codex/session/caller-input.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

test("C-API-14 only sendInput reports caller input; every other member delegates", async () => {
  const written: (string | Uint8Array)[] = [];
  const inner = createHeadlessTerminal({ cols: 40, rows: 5 }, (input) => written.push(input));
  const onInput = vi.fn();
  const terminal = reportCallerInput(inner, onInput);
  await terminal.writeOutput("hello");
  await terminal.settled();
  terminal.resize({ cols: 50, rows: 6 });
  expect(terminal.snapshot().text).toContain("hello");
  expect([terminal.size, terminal.title, terminal.xterm]).toEqual([
    { cols: 50, rows: 6 },
    "",
    inner.xterm,
  ]);
  expect(onInput).not.toHaveBeenCalled();
  await terminal.sendInput("typed");
  expect(onInput).toHaveBeenCalledTimes(1);
  expect(written).toEqual(["typed"]);
  terminal.dispose();
  await expect(inner.sendInput("x")).rejects.toThrow("disposed");
});
