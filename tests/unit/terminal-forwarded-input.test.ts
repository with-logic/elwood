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

test("a parser reply does not confirm suppressed input that never forwarded", async () => {
  const writes: unknown[] = [];
  const prepare = vi.fn();
  const { terminal, emit } = setup((input) => writes.push(input));
  terminal.xterm.options.disableStdin = true;
  void observeInputWrite(terminal.xterm, prepare, () => terminal.sendInput("\r")).catch(
    () => undefined,
  );
  terminal.xterm.options.disableStdin = false;
  emit("\x1b[5n");
  await terminal.settled();
  expect(writes).toEqual(["\x1b[0n"]);
  expect(prepare).not.toHaveBeenCalled();
});

test("even a failing byte observer cannot change forwarded data or the caller's buffer", async () => {
  const write = vi.fn();
  const input = Buffer.from([7]);
  const { terminal } = setup(write);
  await observeInputWrite(
    terminal.xterm,
    (observed) => {
      if (typeof observed !== "string") observed[0] = 9;
      throw new Error("observer failed");
    },
    () => terminal.sendInput(input),
  );
  expect(input[0]).toBe(7);
  expect(write).toHaveBeenCalledWith(Buffer.from([7]));
});

test("another terminal's reentrant write cannot consume the current scope", () => {
  const writeFirst = vi.fn();
  const writeSecond = vi.fn();
  const first = setup(writeFirst).terminal;
  const second = setup(writeSecond).terminal;
  const confirm = vi.fn();
  const prepare = vi.fn(() => confirm);
  observeInputWrite(first.xterm, prepare, () => {
    second.xterm.input("second");
    first.xterm.input("first");
  });
  expect(writeFirst).toHaveBeenCalledWith("first");
  expect(writeSecond).toHaveBeenCalledWith("second");
  expect(prepare.mock.calls).toEqual([["first"]]);
  expect(confirm).toHaveBeenCalledOnce();
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

test("prepare can reenter without giving the nested write the original scope", () => {
  const write = vi.fn();
  const { terminal } = setup(write);
  const confirm = vi.fn();
  const prepare = vi.fn((input: string | Uint8Array) => {
    if (input === "original") terminal.xterm.input("from observer");
    return confirm;
  });
  observeInputWrite(terminal.xterm, prepare, () => terminal.xterm.input("original"));
  expect(write.mock.calls).toEqual([["from observer"], ["original"]]);
  expect(prepare.mock.calls).toEqual([["original"]]);
  expect(confirm).toHaveBeenCalledOnce();
});

test.each([
  ["prepare", (fail: () => never) => fail],
  ["confirm", (fail: () => never) => () => fail],
  ["async confirm", (fail: () => never) => () => async () => fail()],
] as const)("contains observer failures from %s", async (_stage, prepare) => {
  const writes: unknown[] = [];
  const { terminal } = setup((input) => writes.push(input));
  const fail = vi.fn(() => {
    throw new Error("observer");
  });
  await expect(
    observeInputWrite(terminal.xterm, prepare(fail), () => terminal.sendInput("x")),
  ).resolves.toBeUndefined();
  expect(writes).toEqual(["x"]);
  expect(fail).toHaveBeenCalledOnce();
});
