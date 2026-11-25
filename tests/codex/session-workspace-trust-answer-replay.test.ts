/** Recheck Codex navigation proof after replaying a native dialog (C-ATTN-08). */
import { mkdirSync, renameSync, rmdirSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { CodexWorkspaceTrustDiscovery } from "../../src/codex/workspace-trust/discovery.ts";
import { resetFakes } from "./helpers.ts";
import { setupWorkspaceAnswer } from "./workspace-trust-answer-helpers.ts";
import { menuWithQuitSelected } from "./workspace-trust-discovery-fixture.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

async function replayDuringNavigation(
  fixture: Awaited<ReturnType<typeof setupWorkspaceAnswer>>,
  onReplay: () => void,
) {
  const { cwd, session, pty, render, request } = fixture;
  const announced = vi.fn();
  const proved = Promise.withResolvers<void>();
  const paused = Promise.withResolvers<void>();
  session.on("dialog", announced);
  try {
    await vi.waitUntil(() => announced.mock.calls.length === 1);
    const answer = session.answerDialog(request.id, request.choices[1]!.id, { timeoutMs: 1_500 });
    const result = answer.catch((error: unknown) => error);
    await vi.waitUntil(() => pty.writes.length === 1 && pty.writes[0] === "\x1b[B");

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
    const replayed = vi.fn(onReplay);
    session.on("dialog", replayed);
    await vi.waitUntil(() => replayed.mock.calls.length === 1);
    return { result };
  } finally {
    paused.resolve();
  }
}

test("C-ATTN-08 late replay rechecks the unchanged selected frame before confirming Quit", async () => {
  const fixture = await setupWorkspaceAnswer();
  try {
    const { result } = await replayDuringNavigation(fixture, () => undefined);
    await expect.poll(() => fixture.pty.writes).toEqual(["\x1b[B", "\r"]);
    fixture.pty.emitExit({ exitCode: 0 });
    expect(await result).toBeUndefined();
  } finally {
    await fixture.session.teardown();
  }
});

test("C-ATTN-08 late replay rejects navigation if its listener replaces the workspace", async () => {
  const fixture = await setupWorkspaceAnswer();
  const { cwd, pty, session } = fixture;
  const previous = `${cwd}-moved`;
  let moved = false;
  try {
    const { result } = await replayDuringNavigation(fixture, () => {
      renameSync(cwd, previous);
      mkdirSync(cwd);
      moved = true;
    });
    expect(await result).toMatchObject({ details: { category: "frame" } });
    expect(pty.writes).toEqual(["\x1b[B"]);
  } finally {
    if (moved) {
      rmdirSync(cwd);
      renameSync(previous, cwd);
    }
    await session.teardown();
  }
});
