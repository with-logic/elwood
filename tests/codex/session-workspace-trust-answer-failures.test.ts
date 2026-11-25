/** Verify failed native confirmation and bounded answer proof recovery (C-ATTN-07). */
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { resetFakes } from "./helpers.ts";
import { menu, setupWorkspaceAnswer } from "./workspace-trust-answer-helpers.ts";
import {
  clear,
  interceptWorkspaceLookup,
  menuWithQuitSelected,
  proofPause,
} from "./workspace-trust-discovery-fixture.ts";

vi.mock("node:fs/promises", { spy: true });
afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test("C-ATTN-07 the replacement may have a different unverified path", async () => {
  const { cwd, session, pty, render, request } = await setupWorkspaceAnswer();
  try {
    const result = session
      .answerDialog(request.id, request.choices[0]!.id)
      .catch((error: unknown) => error);
    await expect.poll(() => pty.writes).toEqual(["\r"]);
    await render(menu(join(cwd, "different")));
    expect(await session.listDialogs()).toEqual([]);
    await render(codexTty(codexComposer));
    expect(await result).toMatchObject({ details: { category: "frame" } });
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 a queued complete replacement cannot be hidden by a clean PTY exit", async () => {
  const { cwd, session, pty, render, request } = await setupWorkspaceAnswer();
  try {
    await render(menuWithQuitSelected(cwd));
    const result = session
      .answerDialog(request.id, request.choices[1]!.id)
      .catch((error: unknown) => error);
    await expect.poll(() => pty.writes).toEqual(["\r"]);
    pty.emitData(clear + menu(cwd, "folder-access-no-hook-bypass"));
    pty.emitExit({ exitCode: 0 });
    expect(await result).toMatchObject({ details: { category: "terminal_exit" } });
    expect(pty.writes).toEqual(["\r"]);
  } finally {
    await session.teardown();
  }
});

test.each([
  false,
  true,
])("C-ATTN-07 a released proof slot only resumes a live answer (aborted=%s)", async (aborted) => {
  const { cwd, session, pty, render, request } = await setupWorkspaceAnswer();
  const abandoned = proofPause();
  const busyList = proofPause();
  await interceptWorkspaceLookup(cwd, (index) => {
    if (index === 0) return abandoned.wait();
    if (index === 2) return busyList.wait();
    return undefined;
  });
  const cancellation = new AbortController();
  try {
    const first = session
      .answerDialog(request.id, request.choices[0]!.id, { signal: cancellation.signal })
      .catch(() => {});
    await abandoned.began;
    cancellation.abort();
    await first;
    const cancelRetry = new AbortController();
    const retry = session.answerDialog(request.id, request.choices[1]!.id, {
      signal: cancelRetry.signal,
    });
    const completed = retry.catch((error: unknown) => error);
    await expect.poll(() => pty.writes).toEqual(["\x1b[B"]);
    let reading: ReturnType<typeof session.listDialogs> | undefined;
    const off = session.on("terminal:data", () => {
      reading ??= session.listDialogs();
    });
    try {
      await render(menuWithQuitSelected(cwd));
      await busyList.began;
      if (aborted) cancelRetry.abort();
      abandoned.release();
      busyList.release();
      await reading;
      if (aborted) {
        expect(await completed).toMatchObject({ details: { category: "aborted" } });
        expect(pty.writes).toEqual(["\x1b[B"]);
        return;
      }
      await expect.poll(() => pty.writes).toEqual(["\x1b[B", "\r"]);
      pty.emitExit({ exitCode: 0 });
      expect(await completed).toBeUndefined();
    } finally {
      off();
    }
  } finally {
    abandoned.release();
    busyList.release();
    await session.teardown();
  }
});

test("C-ATTN-07 unreadable post-Enter native evidence stays inside the typed answer", async () => {
  const { session, pty, request } = await setupWorkspaceAnswer();
  const xterm = session.terminal.xterm;
  const listener = xterm.onData((text) => {
    if (text === "\r") xterm.options.allowProposedApi = false;
  });
  try {
    const answer = session.answerDialog(request.id, request.choices[0]!.id, { timeoutMs: 600 });
    await expect(answer).rejects.toMatchObject({ details: { category: "frame" } });
    expect(pty.writes).toEqual(["\r"]);
  } finally {
    xterm.options.allowProposedApi = true;
    listener.dispose();
    await session.teardown();
  }
});
