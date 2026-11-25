/** Verify Codex Quit settlement cannot lose narrow native proof (C-ATTN-07). */
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceTrustAnswers } from "../../src/core/dialogs/trust-answer/index.ts";
import { PtyOutput } from "../../src/terminal/pty-output.ts";
import { resetFakes } from "./helpers.ts";
import { menu, setupWorkspaceAnswer } from "./workspace-trust-answer-helpers.ts";
import { clear, menuWithQuitSelected } from "./workspace-trust-discovery-fixture.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test("C-ATTN-07 Quit completes without a yield between final proof and acceptance", async () => {
  const { cwd, session, pty, render, request } = await setupWorkspaceAnswer();
  const xterm = session.terminal.xterm;
  const write = xterm.write.bind(xterm);
  const tail = "\x1b[<u\x1b[?25h";
  const pendingTail = Promise.withResolvers<() => void>();
  const exitObserved = Promise.withResolvers<void>();
  const order: string[] = [];
  const nativeExit = WorkspaceTrustAnswers.prototype.nativeExit;
  vi.spyOn(WorkspaceTrustAnswers.prototype, "nativeExit").mockImplementation(function (
    this: WorkspaceTrustAnswers,
    matches,
  ) {
    if (matches) order.push("accept");
    nativeExit.call(this, matches);
  });
  try {
    await render(menuWithQuitSelected(cwd));
    xterm.write = (data, callback) => {
      if (data === tail) write(data, () => pendingTail.resolve(() => callback?.()));
      else write(data, callback);
    };
    session.on("terminal:exit", () => {
      void session.terminal.settled().then(() => {
        session.terminal.resize({ cols: 99, rows: 39 });
        order.push("mutation");
      });
      exitObserved.resolve();
    });
    const result = session
      .answerDialog(request.id, request.choices[1]!.id)
      .catch((error: unknown) => error);
    await expect.poll(() => pty.writes).toEqual(["\r"]);
    pty.emitData(tail);
    pty.emitExit({ exitCode: 0 });
    await exitObserved.promise;
    (await pendingTail.promise)();
    expect(await result).toBeUndefined();
    expect(order).toEqual(["accept", "mutation"]);
  } finally {
    xterm.write = write;
    await session.teardown();
  }
});

test("C-ATTN-07 Quit does not succeed when a settled repaint selects the affirmative choice", async () => {
  const { cwd, session, pty, render, request } = await setupWorkspaceAnswer();
  try {
    await render(menuWithQuitSelected(cwd));
    const result = session
      .answerDialog(request.id, request.choices[1]!.id)
      .catch((error: unknown) => error);
    await expect.poll(() => pty.writes).toEqual(["\r"]);
    await render(menu(cwd));
    pty.emitExit({ exitCode: 0 });
    expect(await result).toMatchObject({ details: { category: "terminal_exit" } });
    expect(pty.writes).toEqual(["\r"]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 a replacement observed before buffer restoration still vetoes Quit", async () => {
  const { cwd, session, pty, render, request } = await setupWorkspaceAnswer();
  const replacement = clear + menu(cwd, "folder-access-no-hook-bypass");
  const restore = "\x1b[?1049l";
  const push = PtyOutput.prototype.push;
  vi.spyOn(PtyOutput.prototype, "push").mockImplementation(function (this: PtyOutput, data) {
    push.call(this, data);
    // Hand restoration to the active settlement pass before checking the veto.
    if (data === restore) this.flush();
  });
  try {
    await render(`\x1b[?1049h${menuWithQuitSelected(cwd)}`);
    session.on("terminal:data", ({ data }) => {
      if (data === replacement) pty.emitData(restore);
    });
    const result = session
      .answerDialog(request.id, request.choices[1]!.id)
      .catch((error: unknown) => error);
    await expect.poll(() => pty.writes).toEqual(["\r"]);
    pty.emitData(replacement);
    pty.emitExit({ exitCode: 0 });
    expect(await result).toMatchObject({ details: { category: "terminal_exit" } });
    expect(pty.writes).toEqual(["\r"]);
  } finally {
    await session.teardown();
  }
});
