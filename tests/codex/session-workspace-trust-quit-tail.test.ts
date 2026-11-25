/** Verify final native output for a Codex Quit (C-ATTN-07). */
import { afterEach, expect, test, vi } from "vitest";
import { resetFakes } from "./helpers.ts";
import { menu, setupWorkspaceAnswer } from "./workspace-trust-answer-helpers.ts";
import { clear, menuWithQuitSelected } from "./workspace-trust-discovery-fixture.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test("C-ATTN-07 harmless final native terminal-mode bytes do not reject a clean Quit", async () => {
  const { cwd, session, pty, render, request } = await setupWorkspaceAnswer();
  try {
    await render(menuWithQuitSelected(cwd));
    const result = session
      .answerDialog(request.id, request.choices[1]!.id)
      .catch((error: unknown) => error);
    await expect.poll(() => pty.writes).toEqual(["\r"]);
    pty.emitData("\x1b[<u\x1b[?25h");
    pty.emitExit({ exitCode: 0 });
    expect(session.status).toBe("exited");
    expect(pty.writes).toEqual(["\r"]);
    expect(await result).toBeUndefined();
  } finally {
    await session.teardown();
  }
});

const unreadableTail = expect.objectContaining({
  details: expect.objectContaining({ category: "terminal_exit" }),
});

test.each([
  {
    scenario: "normal buffer clears without proof",
    open: "",
    tail: `${clear}Unrecognized shutdown output`,
    expected: unreadableTail,
  },
  {
    scenario: "alternate buffer clears without proof",
    open: "\x1b[?1049h",
    tail: `${clear}Unrecognized shutdown output`,
    expected: unreadableTail,
  },
  {
    scenario: "alternate buffer restores the normal buffer",
    open: "\x1b[?1049h",
    tail: "\x1b[?1049l",
    expected: undefined,
  },
])("C-ATTN-07 Quit settlement when the $scenario", async ({ open, tail, expected }) => {
  const { cwd, session, pty, render, request } = await setupWorkspaceAnswer();
  try {
    await render(open + menuWithQuitSelected(cwd));
    const result = session
      .answerDialog(request.id, request.choices[1]!.id)
      .catch((error: unknown) => error);
    await expect.poll(() => pty.writes).toEqual(["\r"]);
    pty.emitData(tail);
    pty.emitExit({ exitCode: 0 });
    expect(session.status).toBe("exited");
    expect(await result).toEqual(expected);
    expect(pty.writes).toEqual(["\r"]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 a replacement in the restored normal buffer prevents Quit confirmation", async () => {
  const { cwd, session, pty, render, request } = await setupWorkspaceAnswer();
  try {
    await render(`\x1b[?1049h${menuWithQuitSelected(cwd)}`);
    const result = session
      .answerDialog(request.id, request.choices[1]!.id)
      .catch((error: unknown) => error);
    await expect.poll(() => pty.writes).toEqual(["\r"]);
    pty.emitData(`\x1b[?1049l${clear}${menu(cwd, "folder-access-no-hook-bypass")}`);
    pty.emitExit({ exitCode: 0 });
    expect(await result).toMatchObject({ details: { category: "terminal_exit" } });
    expect(pty.writes).toEqual(["\r"]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 unreadable native Quit evidence rejects before trying to wait", async () => {
  const { cwd, session, pty, render, request } = await setupWorkspaceAnswer();
  const xterm = session.terminal.xterm;
  try {
    await render(menuWithQuitSelected(cwd));
    const result = session
      .answerDialog(request.id, request.choices[1]!.id)
      .catch((error: unknown) => error);
    await expect.poll(() => pty.writes).toEqual(["\r"]);
    xterm.options.allowProposedApi = false;
    pty.emitExit({ exitCode: 0 });
    expect(await result).toMatchObject({ details: { category: "frame" } });
    expect(pty.writes).toEqual(["\r"]);
  } finally {
    xterm.options.allowProposedApi = true;
    await session.teardown();
  }
});

test("C-ATTN-07 the original answer deadline still bounds an unsettled Quit", async () => {
  const { cwd, session, pty, render, request } = await setupWorkspaceAnswer();
  const xterm = session.terminal.xterm;
  const write = xterm.write.bind(xterm);
  const tail = "\x1b[<u\x1b[?25h";
  let release: (() => void) | undefined;
  try {
    await render(menuWithQuitSelected(cwd));
    xterm.write = (data, callback) => {
      if (data === tail)
        write(data, () => {
          release = callback;
        });
      else write(data, callback);
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const result = session
      .answerDialog(request.id, request.choices[1]!.id, { timeoutMs: 600 })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(pty.writes).toEqual(["\r"]));
    pty.emitData(tail);
    pty.emitExit({ exitCode: 0 });
    expect(session.status).toBe("exited");
    await vi.advanceTimersByTimeAsync(600);
    expect(await result).toMatchObject({ details: { category: "native_acceptance" } });
    expect(pty.writes).toEqual(["\r"]);
  } finally {
    vi.useRealTimers();
    release?.();
    xterm.write = write;
    await session.teardown();
  }
});
