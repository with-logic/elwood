/** Exercise current native evidence and write refusal through the real session (C-ATTN-07). */
import { mkdirSync, renameSync, rmdirSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { resetFakes } from "./helpers.ts";
import { menu, setupWorkspaceAnswer } from "./workspace-trust-answer-helpers.ts";
import { menuWithQuitSelected } from "./workspace-trust-discovery-fixture.ts";

afterEach(resetFakes);

test("C-ATTN-07 received and still-pending PTY output withholds the first key", async () => {
  const { cwd, session, pty, request, render } = await setupWorkspaceAnswer();
  try {
    const pending = render(menu(cwd));
    await expect(session.answerDialog(request.id, request.choices[0]!.id)).rejects.toMatchObject({
      code: "dialog_answer_failed",
      details: { category: "frame" },
    });
    await pending;
    expect(pty.writes).toEqual([]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 a changed workspace scope retires the original ID before writing", async () => {
  const { cwd, session, pty, request } = await setupWorkspaceAnswer();
  const old = `${cwd}-moved`;
  try {
    renameSync(cwd, old);
    mkdirSync(cwd);
    try {
      await expect(session.answerDialog(request.id, request.choices[0]!.id)).rejects.toMatchObject({
        code: "dialog_answer_failed",
        details: { category: "frame" },
      });
      expect(await session.listDialogs()).toEqual([]);
    } finally {
      rmdirSync(cwd);
      renameSync(old, cwd);
    }
    await expect(session.answerDialog(request.id, request.choices[0]!.id)).rejects.toMatchObject({
      code: "dialog_not_found",
    });
    expect(pty.writes).toEqual([]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 rejected PTY input leaves the request listable but prevents another answer", async () => {
  const { cwd, session, pty, request, render } = await setupWorkspaceAnswer();
  try {
    pty.failOnWrite = "\r";
    await expect(session.answerDialog(request.id, request.choices[0]!.id)).rejects.toMatchObject({
      code: "dialog_answer_failed",
      details: { category: "terminal_write" },
    });
    await render(menu(cwd));
    expect(await session.listDialogs()).toEqual([request]);
    await expect(session.answerDialog(request.id, request.choices[0]!.id)).rejects.toMatchObject({
      code: "dialog_answer_failed",
      details: { category: "frame" },
    });
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 a synchronized composer paint cannot prove acceptance before settlement", async () => {
  const { session, pty, render, request } = await setupWorkspaceAnswer();
  try {
    const answer = session.answerDialog(request.id, request.choices[0]!.id);
    let accepted = false;
    void answer.then(
      () => {
        accepted = true;
      },
      () => undefined,
    );
    await expect.poll(() => pty.writes).toEqual(["\r"]);
    await render(`\x1b[?2026h${codexTty(codexComposer)}`);
    expect(accepted).toBe(false);
    await render(`\x1b[?2026l${codexTty(codexComposer)}`);
    await expect(answer).resolves.toBeUndefined();
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 viewport resizing revokes an answer before the native-exit observer runs", async () => {
  const { cwd, session, pty, render, request } = await setupWorkspaceAnswer();
  try {
    await render(menuWithQuitSelected(cwd));
    const answer = session.answerDialog(request.id, request.choices[1]!.id);
    const cancelled = expect(answer).rejects.toMatchObject({
      code: "dialog_answer_failed",
      details: { category: "aborted" },
    });
    await expect.poll(() => pty.writes).toEqual(["\r"]);
    session.terminal.xterm.resize(127, 28);
    pty.emitExit({ exitCode: 0 });
    await cancelled;
    expect(await session.listDialogs()).toEqual([]);
  } finally {
    await session.teardown();
  }
});

const terminalExitFailure = expect.objectContaining({
  details: expect.objectContaining({ category: "terminal_exit" }),
});

test.each([
  { exit: { exitCode: 0 }, expected: undefined },
  { exit: { exitCode: 0, signal: 0 }, expected: undefined },
  { exit: { exitCode: 1 }, expected: terminalExitFailure },
  { exit: { exitCode: 0, signal: 9 }, expected: terminalExitFailure },
])("C-ATTN-07 Quit requires a selected row and clean exit ($exit)", async ({ exit, expected }) => {
  const { cwd, session, pty, render, request } = await setupWorkspaceAnswer();
  try {
    const answer = session.answerDialog(request.id, request.choices[1]!.id);
    let settled = false;
    const completion = answer.then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await expect.poll(() => pty.writes).toEqual(["\x1b[B"]);
    await render(menuWithQuitSelected(cwd));
    await expect.poll(() => pty.writes).toEqual(["\x1b[B", "\r"]);
    expect(settled).toBe(false);
    pty.emitExit(exit);
    expect(await completion).toEqual(expected);
    expect(await session.listDialogs()).toEqual([]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 a scope change after Down prevents confirmation on the new checkout", async () => {
  const { cwd, session, pty, request, render } = await setupWorkspaceAnswer();
  const previous = `${cwd}-moved`;
  try {
    const answer = session.answerDialog(request.id, request.choices[1]!.id, { timeoutMs: 1_000 });
    const outcome = answer.catch((error: unknown) => error);
    await expect.poll(() => pty.writes).toEqual(["\x1b[B"]);
    renameSync(cwd, previous);
    mkdirSync(cwd);
    try {
      await render(menuWithQuitSelected(cwd));
      const result = await outcome;
      expect(pty.writes).toEqual(["\x1b[B"]);
      expect(result).toMatchObject({
        code: "dialog_answer_failed",
        details: { category: "frame" },
      });
    } finally {
      rmdirSync(cwd);
      renameSync(previous, cwd);
    }
  } finally {
    await session.teardown();
  }
});
