/** Exercise structured workspace answers through the live session and PTY (C-ATTN-07). */
import { realpathSync } from "node:fs";
import { afterEach, assert, expect, test } from "vitest";
import { CodexSession } from "../../src/index.ts";
import { codexComposer, codexTty, tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { menu, setupWorkspaceAnswer } from "./workspace-trust-answer-helpers.ts";
import { clear, menuWithQuitSelected } from "./workspace-trust-discovery-fixture.ts";

afterEach(resetFakes);
function watch(operation: Promise<unknown>) {
  const state = { settled: false };
  const settled = () => {
    state.settled = true;
  };
  void operation.then(settled, settled);
  return state;
}
test("C-ATTN-07 native acceptance survives raw keys from the ready callback", async () => {
  const { cwd, session, pty, render, request } = await setupWorkspaceAnswer();
  try {
    const answer = session.answerDialog(request.id, request.choices[0]!.id);
    const completion = watch(answer);
    await expect.poll(() => pty.writes).toEqual(["\r"]);
    await becomeReady(session.elwoodSessionId, cwd);
    let pendingAtReady: boolean | undefined;
    let raw: Promise<void> | undefined;
    session.on("status", ({ status }) => {
      if (status === "ready") {
        pendingAtReady = !completion.settled;
        raw = session.sendKeys("draft");
      }
    });
    await render(codexTty(codexComposer));
    expect(pendingAtReady).toBe(true);
    assert.isDefined(raw);
    await raw;
    await expect(answer).resolves.toBeUndefined();
    expect(await session.listDialogs()).toEqual([]);
    expect(pty.writes).toEqual(["\r", "draft"]);
    await session.sendKeys(" continues");
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 a different native workspace menu cannot acknowledge the prior answer", async () => {
  const { cwd, session, pty, render, request } = await setupWorkspaceAnswer();
  try {
    await render(menuWithQuitSelected(cwd));
    const answer = session.answerDialog(request.id, request.choices[0]!.id);
    const replaced = expect(answer).rejects.toMatchObject({
      code: "dialog_answer_failed",
      details: { category: "frame" },
    });
    await expect.poll(() => pty.writes).toEqual(["\x1b[A"]);
    await render(menu(cwd));
    await expect.poll(() => pty.writes).toEqual(["\x1b[A", "\r"]);
    await render(menu(cwd, "folder-access-no-hook-bypass"));
    await render(codexTty(codexComposer));
    await replaced;
    expect(pty.writes).toEqual(["\x1b[A", "\r"]);
  } finally {
    await session.teardown();
  }
});

test.each([
  {
    screen: "prelude",
    paint: ({ cwd, render }: Awaited<ReturnType<typeof setupWorkspaceAnswer>>) =>
      render(menu(cwd).split("  Trust this folder?")[0]!),
    retainsRequest: false,
  },
  { screen: "complete menu", paint: () => undefined, retainsRequest: true },
])("C-ATTN-07 raw input relinquishes trust on the $screen", async ({ paint, retainsRequest }) => {
  const fixture = await setupWorkspaceAnswer();
  const { cwd, session, render, request, pty } = fixture;
  try {
    await paint(fixture);
    await session.sendKeys("\x1b[B");
    await render(menu(cwd));
    const [current] = await session.listDialogs();
    assert.isDefined(current);
    expect(current.id === request.id).toBe(retainsRequest);
    await expect(session.answerDialog(current.id, current.choices[0]!.id)).rejects.toMatchObject({
      code: "dialog_answer_failed",
      details: { category: "frame" },
    });
    expect(pty.writes).toEqual(["\x1b[B"]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 the lazy Codex control rejects an unknown live request", async () => {
  installFakes();
  const session = new CodexSession({ cwd: tempDir(), autotrust: true });
  try {
    await expect(session.answerDialog("stale", "stale")).rejects.toMatchObject({
      code: "dialog_not_found",
    });
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 the lazy Codex control answers a verified live request", async () => {
  installFakes();
  const cwd = realpathSync.native(tempDir());
  const session = new CodexSession({ cwd });
  try {
    const live = await session.start();
    const pty = ptys[0]!;
    pty.emitData(clear + menu(cwd));
    await live.terminal.settled();
    const [request] = await session.listDialogs();
    assert.isDefined(request);
    await expect(
      session.answerDialog(request.id, request.choices[0]!.id, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ details: { category: "aborted" } });
    expect(pty.writes).toEqual([]);
    const answer = session.answerDialog(request.id, request.choices[0]!.id);
    await expect.poll(() => pty.writes).toEqual(["\r"]);
    pty.emitData(clear + codexTty(codexComposer));
    await expect(answer).resolves.toBeUndefined();
  } finally {
    await session.teardown();
  }
});

test.each([
  "codex-0.154.0/hooks",
  "codex-0.164.0/trust/hooks-no-hook-bypass",
])("C-ATTN-07 a complete %s hook review confirms affirmative workspace trust", async (fixture) => {
  const { session, pty, render, request } = await setupWorkspaceAnswer();
  try {
    const answer = session.answerDialog(request.id, request.choices[0]!.id);
    const completed = watch(answer);
    await expect.poll(() => pty.writes).toEqual(["\r"]);
    await render("repainting");
    expect(completed.settled).toBe(false);
    const hookReview = capturedFrame(fixture);
    await render(tty(hookReview.replace("› 1.", "  1.")));
    expect(completed.settled).toBe(false);
    await render(tty(hookReview));
    await expect(answer).resolves.toBeUndefined();
    expect(await session.listDialogs()).toEqual([]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 Back confirms the native Agent Command Center and retains the hold", async () => {
  const { cwd, session, pty, render } = await setupWorkspaceAnswer();
  try {
    await render(
      menu(cwd, "folder-access-no-hook-bypass").replace("› 1.", "  1.").replace("  2.", "› 2."),
    );
    const [request] = await session.listDialogs();
    assert.isDefined(request);
    const queued = watch(session.sendMessage("queued before Back"));
    const answer = session.answerDialog(request.id, request.choices[1]!.id);
    const completed = watch(answer);
    await expect.poll(() => pty.writes).toEqual(["\r"]);
    expect(completed.settled).toBe(false);
    const rule = "─".repeat(session.terminal.snapshot().cols - 4);
    await render(tty(`  Agent command center  Group: Status\n   All 10   Needs you 2\n  ${rule}`));
    await expect(answer).resolves.toBeUndefined();
    expect(session.status).toBe("blocked");
    expect(queued.settled).toBe(false);
    expect(await session.listDialogs()).toEqual([]);
    expect(pty.writes).toEqual(["\r"]);
    const reopened = Promise.withResolvers<string>();
    session.on("dialog", (event) => {
      if (event.phase === "raised") reopened.resolve(event.request.id);
    });
    await session.sendKeys("n");
    await render(menu(cwd, "folder-access-no-hook-bypass"));
    const [next] = await session.listDialogs();
    assert.isDefined(next);
    expect(next.id).not.toBe(request.id);
    await expect(reopened.promise).resolves.toBe(next.id);
    expect(pty.writes).toEqual(["\r", "n"]);
  } finally {
    await session.teardown();
  }
});
