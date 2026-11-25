/** Revoke structured input while Codex launch scope verification is pending (C-ATTN-07). */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { afterEach, assert, expect, test, vi } from "vitest";
import { resetFakes } from "./helpers.ts";
import {
  holdWorkspaceProof,
  menu,
  setupWorkspaceAnswer,
} from "./workspace-trust-answer-helpers.ts";
import { menuWithQuitSelected } from "./workspace-trust-discovery-fixture.ts";

vi.mock("node:fs/promises", { spy: true });
afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test.each([
  "caller input",
  "new frame",
  "abort",
] as const)("C-ATTN-07 %s revokes a held first-key proof", async (change) => {
  const { cwd, session, pty, request, render } = await setupWorkspaceAnswer();
  const held = await holdWorkspaceProof(cwd);
  const abort = new AbortController();
  try {
    const answer = session.answerDialog(request.id, request.choices[0]!.id, {
      signal: abort.signal,
      timeoutMs: 1_000,
    });
    const outcome = answer.then(
      () => "answered",
      (error: unknown) => error,
    );
    const first = await Promise.race([held.began.then(() => "proof"), outcome]);
    expect(first).toBe("proof");
    expect(pty.writes).toEqual([]);
    if (change === "caller input") await session.sendKeys("x");
    if (change === "new frame") await render(menuWithQuitSelected(cwd));
    if (change === "abort") abort.abort();
    held.release();
    await held.resumed;
    const result = await outcome;
    await session.listDialogs();
    expect(pty.writes).toEqual(change === "caller input" ? ["x"] : []);
    expect(result).toMatchObject({
      code: "dialog_answer_failed",
      details: { category: change === "new frame" ? "frame" : "aborted" },
    });
  } finally {
    held.release();
    await session.teardown();
  }
});

test("C-ATTN-07 a newly verified selected row cannot send Enter after raw takeover", async () => {
  const { cwd, session, pty, request, render } = await setupWorkspaceAnswer();
  const answer = session.answerDialog(request.id, request.choices[1]!.id);
  const outcome = expect(answer).rejects.toMatchObject({
    code: "dialog_answer_failed",
    details: { category: "aborted" },
  });
  let held: Awaited<ReturnType<typeof holdWorkspaceProof>> | undefined;
  try {
    await expect.poll(() => pty.writes).toEqual(["\x1b[B"]);
    held = await holdWorkspaceProof(cwd);
    await render(menuWithQuitSelected(cwd));
    await held.began;
    await session.sendKeys("x");
    held.release();
    await held.resumed;
    await outcome;
    const [current] = await session.listDialogs();
    assert.isDefined(current);
    expect(current.id).toBe(request.id);
    expect(pty.writes).toEqual(["\x1b[B", "x"]);
  } finally {
    held?.release();
    await session.teardown();
  }
});

test("C-ATTN-07 a different settled menu refuses the old key while replacement proof is pending", async () => {
  const { cwd, session, pty, request, render } = await setupWorkspaceAnswer();
  const held = await holdWorkspaceProof(cwd);
  try {
    await render(menu(cwd, "folder-access-no-hook-bypass"));
    const reading = session.listDialogs();
    await held.began;
    await expect(session.answerDialog(request.id, request.choices[0]!.id)).rejects.toMatchObject({
      code: "dialog_not_found",
    });
    expect(pty.writes).toEqual([]);
    held.release();
    const [replacement] = await reading;
    expect(replacement?.id).not.toBe(request.id);
    expect(replacement?.choices[1]?.label).toBe("Back to Agent Command Center");
  } finally {
    held.release();
    await session.teardown();
  }
});

test("C-ATTN-07 navigation uses the proof of the same settled frame once", async () => {
  const { cwd, session, pty, request, render } = await setupWorkspaceAnswer();
  const answer = session.answerDialog(request.id, request.choices[1]!.id);
  const done = answer.catch((error: unknown) => error);
  try {
    await expect.poll(() => pty.writes).toEqual(["\x1b[B"]);
    const lookup = vi.mocked(fsp.lstat);
    lookup.mockClear();
    await render(menuWithQuitSelected(cwd));
    await expect.poll(() => pty.writes).toEqual(["\x1b[B", "\r"]);
    expect(lookup.mock.calls.filter(([path]) => path === join(cwd, ".git"))).toHaveLength(1);
    pty.emitExit({ exitCode: 0 });
    expect(await done).toBeUndefined();
  } finally {
    await session.teardown();
    await done;
  }
});

test.each([
  "aborted",
  "frame",
] as const)("C-ATTN-07 writer proof failure (%s) leaves polling discovery available", async (category) => {
  const { cwd, session, pty, request } = await setupWorkspaceAnswer();
  const held = await holdWorkspaceProof(cwd);
  const controller = new AbortController();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const answer = session.answerDialog(request.id, request.choices[0]!.id, {
      signal: controller.signal,
    });
    const rejected = expect(answer).rejects.toMatchObject({ details: { category } });
    await held.began;
    if (category === "aborted") controller.abort();
    await vi.advanceTimersByTimeAsync(510);
    await rejected;
    held.release();
    await held.resumed;
    expect(await session.listDialogs()).toEqual([request]);
    expect(pty.writes).toEqual([]);
  } finally {
    vi.useRealTimers();
    held.release();
    await session.teardown();
  }
});

test("C-ATTN-07 the answer belongs to its own fresh proof while a host list read is pending", async () => {
  const { cwd, session, pty, request } = await setupWorkspaceAnswer();
  const held = await holdWorkspaceProof(cwd);
  try {
    const list = session.listDialogs();
    await held.began;
    const lookup = vi.mocked(fsp.lstat);
    lookup.mockClear();
    const answer = session.answerDialog(request.id, request.choices[0]!.id);
    const result = answer.catch((error: unknown) => error);
    await expect
      .poll(() => lookup.mock.calls.filter(([path]) => path === join(cwd, ".git")))
      .toHaveLength(1);
    expect(pty.writes).toEqual([]);
    await session.sendKeys("x");
    held.release();
    expect(await list).toEqual([request]);
    expect(await result).toMatchObject({
      code: "dialog_answer_failed",
      details: { category: "aborted" },
    });
    expect(pty.writes).toEqual(["x"]);
  } finally {
    held.release();
    await session.teardown();
  }
});
