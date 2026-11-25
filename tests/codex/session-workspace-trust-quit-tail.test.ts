/** Verify final Quit output and late replay during Codex navigation (C-ATTN-07, C-ATTN-08). */
import { mkdirSync, renameSync, rmdirSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { CodexWorkspaceTrustDiscovery } from "../../src/codex/workspace-trust/discovery.ts";
import { resetFakes } from "./helpers.ts";
import { menu, setupWorkspaceAnswer } from "./workspace-trust-answer-helpers.ts";
import { clear, menuWithQuitSelected } from "./workspace-trust-discovery-fixture.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test.each([
  false,
  true,
])("C-ATTN-08 late replay rechecks the unchanged selected frame (scope changed: %s)", async (changed) => {
  const { cwd, session, pty, render, request } = await setupWorkspaceAnswer();
  const announced = vi.fn();
  const proved = Promise.withResolvers<void>();
  const paused = Promise.withResolvers<void>();
  let moved = false;
  session.on("dialog", announced);
  try {
    await expect.poll(() => announced.mock.calls.length).toBe(1);
    const answer = session.answerDialog(request.id, request.choices[1]!.id, { timeoutMs: 1_500 });
    const result = answer.catch((error: unknown) => error);
    await expect.poll(() => pty.writes).toEqual(["\x1b[B"]);

    const { verifyRequestForAnswer } = CodexWorkspaceTrustDiscovery.prototype;
    vi.spyOn(
      CodexWorkspaceTrustDiscovery.prototype,
      "verifyRequestForAnswer",
    ).mockImplementationOnce(async function (this: CodexWorkspaceTrustDiscovery, ...args) {
      const value = await verifyRequestForAnswer.apply(this, args);
      proved.resolve();
      await paused.promise;
      return value;
    });
    await render(menuWithQuitSelected(cwd));
    await proved.promise;
    const replayed = vi.fn(() => {
      if (!changed) return;
      renameSync(cwd, `${cwd}-moved`);
      mkdirSync(cwd);
      moved = true;
    });
    session.on("dialog", replayed);
    await expect.poll(() => replayed.mock.calls.length).toBe(1);
    paused.resolve();
    if (changed) {
      expect(await result).toMatchObject({ details: { category: "frame" } });
      expect(pty.writes).toEqual(["\x1b[B"]);
      return;
    }
    await expect.poll(() => pty.writes, { timeout: 1_000 }).toEqual(["\x1b[B", "\r"]);
    pty.emitExit({ exitCode: 0 });
    expect(await result).toBeUndefined();
  } finally {
    paused.resolve();
    if (moved) {
      rmdirSync(cwd);
      renameSync(`${cwd}-moved`, cwd);
    }
    await session.teardown();
  }
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

test.each([
  { alternate: false, tail: `${clear}Unrecognized shutdown output`, confirms: false },
  { alternate: true, tail: `${clear}Unrecognized shutdown output`, confirms: false },
  { alternate: true, tail: "\x1b[?1049l", confirms: true },
])("C-ATTN-07 Quit requires its native menu or alternate-screen restoration ($#)", async ({
  alternate,
  tail,
  confirms,
}) => {
  const { cwd, session, pty, render, request } = await setupWorkspaceAnswer();
  try {
    await render((alternate ? "\x1b[?1049h" : "") + menuWithQuitSelected(cwd));
    const result = session
      .answerDialog(request.id, request.choices[1]!.id)
      .catch((error: unknown) => error);
    await expect.poll(() => pty.writes).toEqual(["\r"]);
    pty.emitData(tail);
    pty.emitExit({ exitCode: 0 });
    expect(session.status).toBe("exited");
    if (confirms) expect(await result).toBeUndefined();
    else expect(await result).toMatchObject({ details: { category: "terminal_exit" } });
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
    const result = session
      .answerDialog(request.id, request.choices[1]!.id, { timeoutMs: 600 })
      .catch((error: unknown) => error);
    await expect.poll(() => pty.writes).toEqual(["\r"]);
    pty.emitData(tail);
    pty.emitExit({ exitCode: 0 });
    expect(session.status).toBe("exited");
    expect(await result).toMatchObject({ details: { category: "native_acceptance" } });
    expect(pty.writes).toEqual(["\r"]);
  } finally {
    release?.();
    xterm.write = write;
    await session.teardown();
  }
});
