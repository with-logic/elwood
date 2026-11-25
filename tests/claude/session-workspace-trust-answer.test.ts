/** Exercise live Claude trust answers and native confirmation (C-ATTN-07). */
import { realpathSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { ClaudeSession } from "../../src/index.ts";
import { tty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, tempDir } from "./helpers.ts";
import { ready } from "./login-helpers.ts";
import {
  bypass,
  composer,
  selectYes,
  setupClaudeAnswer,
} from "./workspace-trust-answer-fixture.ts";

test.each([
  false,
  true,
])("C-ATTN-07 claude settles input and records acceptance before a ready listener can clear the terminal (%s)", async (mutate) => {
  const { root, cwd, facade, session, pty, render, menu, request, settle } =
    await setupClaudeAnswer({
      repository: true,
    });
  await render(menu("no"));
  const opened = await request();
  expect(opened.targetPath).toBe(root);
  await ready(cwd, session);
  const clear = vi.fn();
  session.on("status", ({ status }) => {
    if (status === "ready") {
      clear();
      if (mutate) session.terminal.xterm.clear();
    }
  });
  const done = facade.answerDialog(opened.id, opened.choices[1]!.id);
  void done.catch(() => undefined);
  await settle(1);
  expect(pty.writes).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(pty.writes).toEqual([selectYes]));
  await render(menu("yes"));
  await vi.waitFor(() => expect(pty.writes).toEqual([selectYes, `${selectYes}\r`]));
  await render(composer);
  await done;
  expect(clear).toHaveBeenCalledOnce();
  expect(await session.listDialogs()).toEqual([]);
  await session.sendKeys("\u001b");
});

test.each([
  [{ exitCode: 1, signal: 0 }, true],
  [{ exitCode: 1, signal: 9 }, false],
  [{ exitCode: 0 }, false],
] as const)("C-ATTN-07 a confirmed decline waits for the expected native exit (%j)", async (exit, accepted) => {
  const { session, pty, render, menu, request, settle } = await setupClaudeAnswer();
  await render(menu("no"));
  const opened = await request();
  const settled = vi.fn();
  await settle();
  const done = session.answerDialog(opened.id, opened.choices[0]!.id).then(settled);
  void done.catch(() => undefined);
  await vi.waitFor(() => expect(pty.writes).toEqual(["\x1b[H\r"]));
  await render(tty(bypass));
  expect(settled).not.toHaveBeenCalled();
  pty.emitExit(exit);
  if (accepted) {
    await done;
    expect(settled).toHaveBeenCalledOnce();
  } else {
    await expect(done).rejects.toMatchObject({ details: { category: "terminal_exit" } });
    expect(settled).not.toHaveBeenCalled();
  }
});

test("C-ATTN-07 the incomplete bypass successor cannot acknowledge workspace acceptance", async () => {
  const { session, pty, render, menu, request, settle } = await setupClaudeAnswer();
  await render(menu("yes"));
  const opened = await request();
  const settled = vi.fn();
  const done = session.answerDialog(opened.id, opened.choices[1]!.id).then(settled);
  void done.catch(() => undefined);
  await settle();
  await vi.waitFor(() => expect(pty.writes).toEqual([`${selectYes}\r`]));
  for (const partial of [
    "",
    "WARNING: Claude Code running in Bypass Permissions mode",
    bypass.replace("Enter to confirm · Esc to cancel", ""),
    bypass.replace("    Yes, I accept\n", ""),
  ]) {
    await render(tty(partial));
    expect(settled).not.toHaveBeenCalled();
  }
  await render(tty(bypass));
  await done;
  expect(pty.writes).toEqual([`${selectYes}\r`]);
  expect(session.status).toBe("blocked");
  expect(await session.listDialogs()).toEqual([]);
});

test("C-ATTN-07 a changed choice order retires the reserved answer before writing", async () => {
  const { session, pty, render, menu, request } = await setupClaudeAnswer();
  await render(menu("yes"));
  const opened = await request();
  const failed = expect(
    session.answerDialog(opened.id, opened.choices[1]!.id),
  ).rejects.toMatchObject({ details: { category: "frame" } });
  await render(
    menu("yes").replace(
      "   No, exit\r\n ❯ Yes, I trust this folder",
      " ❯ Yes, I trust this folder\r\n   No, exit",
    ),
  );
  await failed;
  expect((await request()).id).not.toBe(opened.id);
  expect(pty.writes).toEqual([]);
});

test("C-ATTN-07 a cold Claude facade launches before validating a dialog request", async () => {
  installFakes();
  const facade = new ClaudeSession({ cwd: realpathSync(tempDir()) });
  try {
    expect(ptys).toEqual([]);
    await expect(facade.answerDialog("absent", "absent")).rejects.toMatchObject({
      code: "dialog_not_found",
    });
    expect(ptys).toHaveLength(1);
  } finally {
    await facade.teardown();
  }
});

test("C-ATTN-07 a lazy Claude facade forwards signal and timeout to its native answer", async () => {
  const { facade, pty, render, menu, request, beforeProof } = await setupClaudeAnswer();
  await render(menu("yes"));
  const opened = await request();
  const stop = new AbortController();
  const answer = facade
    .answerDialog(opened.id, opened.choices[1]!.id, { signal: stop.signal })
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  stop.abort();
  await vi.advanceTimersByTimeAsync(13_000);
  expect(await answer).toMatchObject({ details: { category: "aborted" } });
  const held = Promise.withResolvers<boolean>();
  beforeProof.mockImplementationOnce(() => held.promise);
  const settled = vi.fn();
  const expired = facade
    .answerDialog(opened.id, opened.choices[1]!.id, { timeoutMs: 50 })
    .catch((error: unknown) => {
      settled();
      return error;
    });
  try {
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toHaveBeenCalledOnce();
    expect(await expired).toMatchObject({ details: { category: "frame" } });
    expect(pty.writes).toEqual([]);
  } finally {
    held.resolve(true);
  }
});
