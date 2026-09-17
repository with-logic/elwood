/** The session-facing terminal reports caller input and otherwise delegates (C-API-14). */
import { expect, test, vi } from "vitest";
import { reportCallerInput } from "../../src/codex/session/caller-input.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

test("C-API-14 every caller path reports input; automation and other members do not", async () => {
  const written: (string | Uint8Array)[] = [];
  const inner = createHeadlessTerminal({ cols: 40, rows: 5 }, (input) => written.push(input));
  const onInput = vi.fn();
  const { terminal, automation } = reportCallerInput(inner, onInput);
  await terminal.writeOutput("hello");
  await terminal.settled();
  terminal.resize({ cols: 50, rows: 6 });
  expect(terminal.snapshot().text).toContain("hello");
  expect([terminal.size, terminal.title, terminal.xterm]).toEqual([
    { cols: 50, rows: 6 },
    "",
    inner.xterm,
  ]);
  await automation("1\r");
  expect(onInput).not.toHaveBeenCalled();
  // Raw bytes skip xterm's data event; the public xterm skips sendInput.
  await terminal.sendInput(new Uint8Array([22]));
  expect(onInput).toHaveBeenCalledTimes(1);
  terminal.xterm.input("typed");
  expect(onInput).toHaveBeenCalledTimes(2);
  expect(written).toEqual(["1\r", new Uint8Array([22]), "typed"]);
  terminal.dispose();
  await expect(inner.sendInput("x")).rejects.toThrow("disposed");
});

test("C-API-14 a resumed session reports prior input before any frame is read", () => {
  const inner = createHeadlessTerminal({ cols: 40, rows: 5 }, () => {});
  const onInput = vi.fn();
  reportCallerInput(inner, onInput, true);
  expect(onInput).toHaveBeenCalledTimes(1);
  inner.dispose();
});
