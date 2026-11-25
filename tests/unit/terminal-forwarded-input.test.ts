/** Exercise passive forwarding observations through actual xterm and a fake PTY (PRD §5.3). */
import { expect, onTestFinished, test, vi } from "vitest";
import type { PtyProcess } from "../../src/pty/types.ts";
import { observeInputWrite } from "../../src/terminal/forwarded-input.ts";
import { setupTerminalPty } from "../helpers/terminal-pty.ts";

function setup(write: PtyProcess["write"]) {
  const attached = setupTerminalPty(undefined, write);
  onTestFinished(() => attached.terminal.dispose());
  return attached;
}

test.each([
  "\r",
  Uint8Array.of(0, 255),
])("observes the exact PTY input around successful forwarding", async (input) => {
  const order: unknown[] = [];
  const { terminal } = setup((actual) => order.push(["write", actual]));
  await observeInputWrite(
    terminal.xterm,
    (actual) => {
      order.push(["prepare", actual]);
      return () => {
        order.push(["confirmed", actual]);
      };
    },
    () => terminal.sendInput(input),
  );
  expect(order).toEqual([
    ["prepare", input],
    ["write", input],
    ["confirmed", input],
  ]);
});

test("a parser reply can settle the existing waiter without confirming suppressed input", async () => {
  const writes: unknown[] = [];
  const prepare = vi.fn();
  const { terminal, emit } = setup((input) => writes.push(input));
  terminal.xterm.options.disableStdin = true;
  const send = observeInputWrite(terminal.xterm, prepare, () => terminal.sendInput("\r"));
  terminal.xterm.options.disableStdin = false;
  emit("\x1b[5n");
  await terminal.settled();
  await expect(send).resolves.toBeUndefined();
  expect(writes).toEqual(["\x1b[0n"]);
  expect(prepare).not.toHaveBeenCalled();
});

test("write failure suppresses confirmation without swallowing the send error", async () => {
  const confirm = vi.fn();
  const { terminal } = setup(() => {
    throw new Error("PTY closed");
  });
  await expect(
    observeInputWrite(
      terminal.xterm,
      () => confirm,
      () => terminal.sendInput("\r"),
    ),
  ).rejects.toThrow("PTY closed");
  expect(confirm).not.toHaveBeenCalled();
});

test("nested scopes restore their parent after throws, and reentrant inputs stay unobserved", () => {
  const writes: unknown[] = [];
  const seen: unknown[] = [];
  const { terminal } = setup((input) => {
    writes.push(input);
    if (input === "outer") terminal.xterm.input("reentrant");
  });
  const prepare = (input: string | Uint8Array) => () => {
    seen.push(input);
  };
  observeInputWrite(terminal.xterm, prepare, () => {
    expect(() =>
      observeInputWrite(terminal.xterm, prepare, () => {
        terminal.xterm.input("inner");
        throw new Error("dispatch");
      }),
    ).toThrow("dispatch");
    observeInputWrite(
      terminal.xterm,
      () => undefined,
      () => terminal.xterm.input("declined"),
    );
    terminal.xterm.input("outer");
    terminal.xterm.input("unscoped");
  });
  expect(writes).toEqual(["inner", "declined", "outer", "reentrant", "unscoped"]);
  expect(seen).toEqual(["inner", "outer"]);
});

test.each([
  "prepare",
  "confirm",
  "async confirm",
])("contains observer failures from %s", async (stage) => {
  const writes: unknown[] = [];
  const { terminal } = setup((input) => writes.push(input));
  const fail = vi.fn(() => {
    throw new Error("observer");
  });
  await expect(
    observeInputWrite(
      terminal.xterm,
      () => {
        if (stage === "prepare") fail();
        return stage === "confirm" ? fail : async () => fail();
      },
      () => terminal.sendInput("x"),
    ),
  ).resolves.toBeUndefined();
  expect(writes).toEqual(["x"]);
  expect(fail).toHaveBeenCalledOnce();
});
