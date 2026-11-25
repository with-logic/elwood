/** Check overlapping Codex workspace answer proofs against the live PTY (C-ATTN-07). */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CodexWorkspaceTrustDiscovery } from "../../src/codex/workspace-trust/discovery.ts";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { resetFakes } from "./helpers.ts";
import {
  holdWorkspaceProof,
  menu,
  setupWorkspaceAnswer,
} from "./workspace-trust-answer-helpers.ts";
import {
  interceptWorkspaceLookup,
  menuWithQuitSelected,
  proofPause,
} from "./workspace-trust-discovery-fixture.ts";

vi.mock("node:fs/promises", { spy: true });
afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test("C-ATTN-07 a canceled proof cannot retire a retry that sent Enter on the same frame", async () => {
  const { cwd, session, pty, request, render } = await setupWorkspaceAnswer();
  const pause = proofPause();
  const failed = Promise.withResolvers<void>();
  await interceptWorkspaceLookup(cwd, (index) =>
    index === 0
      ? pause.wait().then(() => {
          failed.resolve();
          throw Object.assign(new Error("stale Git metadata error"), { code: "EIO" });
        })
      : undefined,
  );
  const controller = new AbortController();
  try {
    const first = session.answerDialog(request.id, request.choices[0]!.id, {
      signal: controller.signal,
    });
    const firstResult = first.catch((error: unknown) => error);
    await pause.began;
    controller.abort();
    expect(await firstResult).toMatchObject({ details: { category: "aborted" } });

    const retry = session.answerDialog(request.id, request.choices[0]!.id);
    const retryResult = retry.catch((error: unknown) => error);
    await expect.poll(() => pty.writes).toEqual(["\r"]);
    pause.release();
    await failed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await render(codexTty(codexComposer));
    expect(await retryResult).toBeUndefined();
  } finally {
    pause.release();
    await session.teardown();
  }
});

test("C-ATTN-07 navigation verifies one frame at a time and retries only the latest repaint", async () => {
  const { cwd, session, pty, request, render } = await setupWorkspaceAnswer();
  const answer = session.answerDialog(request.id, request.choices[1]!.id);
  const result = answer.catch((error: unknown) => error);
  let held: Awaited<ReturnType<typeof holdWorkspaceProof>> | undefined;
  try {
    await expect.poll(() => pty.writes).toEqual(["\x1b[B"]);
    held = await holdWorkspaceProof(cwd);
    vi.mocked(fsp.lstat).mockClear();
    const selected = menuWithQuitSelected(cwd);
    await render(selected);
    await held.began;
    await render(menu(cwd));
    await render(selected);
    const lookups = () =>
      vi.mocked(fsp.lstat).mock.calls.filter(([path]) => path === join(cwd, ".git"));
    expect(lookups()).toHaveLength(1);
    expect(pty.writes).toEqual(["\x1b[B"]);
    held.release();
    await expect.poll(() => pty.writes).toEqual(["\x1b[B", "\r"]);
    expect(lookups()).toHaveLength(2);
    pty.emitExit({ exitCode: 0 });
    expect(await result).toBeUndefined();
  } finally {
    held?.release();
    await session.teardown();
  }
});

test("C-ATTN-07 an already relinquished answer performs no filesystem proof", async () => {
  const { session, pty, request } = await setupWorkspaceAnswer();
  try {
    await session.sendKeys("x");
    const lookup = vi.mocked(fsp.lstat);
    lookup.mockClear();
    await expect(session.answerDialog(request.id, request.choices[0]!.id)).rejects.toMatchObject({
      details: { category: "frame" },
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(pty.writes).toEqual(["x"]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 two canceled verification reads bound further filesystem work", async () => {
  const { cwd, session, pty, request } = await setupWorkspaceAnswer();
  const held = await holdWorkspaceProof(cwd);
  vi.mocked(fsp.lstat).mockClear();
  const lookups = () =>
    vi.mocked(fsp.lstat).mock.calls.filter(([path]) => path === join(cwd, ".git"));
  async function cancelRead(count: number) {
    const controller = new AbortController();
    const answer = session.answerDialog(request.id, request.choices[0]!.id, {
      signal: controller.signal,
    });
    const failed = expect(answer).rejects.toMatchObject({ details: { category: "aborted" } });
    await expect.poll(() => lookups()).toHaveLength(count);
    controller.abort();
    await failed;
  }
  try {
    await cancelRead(1);
    await cancelRead(2);
    await expect(session.answerDialog(request.id, request.choices[0]!.id)).rejects.toMatchObject({
      details: { category: "frame" },
    });
    expect(lookups()).toHaveLength(2);
    expect(pty.writes).toEqual([]);
  } finally {
    held.release();
    await session.teardown();
  }
});

test("C-ATTN-07 a current proof timeout after Down ends the answer and preserves listing", async () => {
  const { cwd, session, pty, request, render } = await setupWorkspaceAnswer();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const answer = session.answerDialog(request.id, request.choices[1]!.id, { timeoutMs: 3_000 });
  const result = answer.catch((error: unknown) => error);
  let held: Awaited<ReturnType<typeof holdWorkspaceProof>> | undefined;
  try {
    await vi.waitFor(() => expect(pty.writes).toEqual(["\x1b[B"]));
    held = await holdWorkspaceProof(cwd);
    const selected = menuWithQuitSelected(cwd);
    const painting = render(selected);
    await vi.advanceTimersByTimeAsync(10);
    await painting;
    await held.began;
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toMatchObject({ details: { category: "frame" } });
    vi.useRealTimers();
    held.release();
    await held.resumed;
    await render(selected);
    expect(await session.listDialogs()).toEqual([request]);
    expect(pty.writes).toEqual(["\x1b[B"]);
  } finally {
    vi.useRealTimers();
    held?.release();
    await session.teardown();
  }
});

test("C-ATTN-07 a replacement after navigation does not start another proof for the retired request", async () => {
  const { cwd, session, pty, request, render } = await setupWorkspaceAnswer();
  const proof = vi.spyOn(CodexWorkspaceTrustDiscovery.prototype, "verifyRequestForAnswer");
  const answer = session.answerDialog(request.id, request.choices[1]!.id);
  const result = answer.catch((error: unknown) => error);
  try {
    await expect.poll(() => pty.writes).toEqual(["\x1b[B"]);
    expect(proof).toHaveBeenCalledOnce();
    await render(menu(cwd, "folder-access-no-hook-bypass"));
    await expect
      .poll(() => Promise.race([result, Promise.resolve("pending")]))
      .toMatchObject({ details: { category: "frame" } });
    expect(proof).toHaveBeenCalledOnce();
    expect(pty.writes).toEqual(["\x1b[B"]);
  } finally {
    await session.teardown();
  }
});
