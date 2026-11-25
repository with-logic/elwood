/** Keep Claude list evidence separate from lifecycle callbacks (C-ATTN-08). */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as target from "../../src/claude/workspace-trust/target.ts";
import { type ElwoodDialogEvent, type ElwoodDialogRequest, startClaude } from "../../src/index.ts";
import { holdFirstGitLookup } from "../helpers/hold-git-lookup.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { trustFrame } from "./workspace-trust-discovery-fixture.ts";

vi.mock("../../src/claude/workspace-trust/target.ts", { spy: true });
vi.mock("node:fs/promises", { spy: true });
afterEach(() => {
  vi.mocked(target.captureClaudeStartupTrustEvidence).mockReset();
  vi.mocked(lstat).mockReset();
  vi.restoreAllMocks();
  resetFakes();
});

test("C-ATTN-08 a pending Claude list cannot return proof that spans a raised listener", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const originalCapture = (
    await vi.importActual<typeof target>("../../src/claude/workspace-trust/target.ts")
  ).captureClaudeStartupTrustEvidence;
  const publisherStarted = Promise.withResolvers<void>();
  const listVerified = Promise.withResolvers<void>();
  const listRelease = Promise.withResolvers<void>();
  const reentrantList = Promise.withResolvers<readonly ElwoodDialogRequest<"claude">[]>();
  const reentryStarted = Promise.withResolvers<void>();
  const reentryRelease = Promise.withResolvers<void>();
  vi.mocked(target.captureClaudeStartupTrustEvidence).mockImplementation(async (directory) => {
    const evidence = await originalCapture(directory);
    if (!evidence) throw new Error("Expected checked workspace evidence.");
    let reads = 0;
    return {
      scope: evidence.scope,
      isCurrent: async (signal) => {
        const read = ++reads;
        if (read === 1) publisherStarted.resolve();
        if (read === 3) reentryStarted.resolve();
        const current = await evidence.isCurrent(signal);
        if (read === 1) await listVerified.promise;
        if (read === 2) {
          listVerified.resolve();
          await listRelease.promise;
        }
        if (read === 3) await reentryRelease.promise;
        return current;
      },
    };
  });
  const session = await startClaude({ cwd });
  const observed = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  session.on("dialog", (event) => {
    observed(event);
    if (event.phase === "raised") {
      mkdirSync(join(cwd, ".git"));
      writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
      reentrantList.resolve(session.listDialogs());
      listRelease.resolve();
    }
  });
  try {
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
    await publisherStarted.promise;
    const lists = Promise.all([session.listDialogs(), session.listDialogs()]);
    await reentryStarted.promise;
    // Release the newer check after both older readers can join it.
    await new Promise<void>((resolve) => setImmediate(resolve));
    reentryRelease.resolve();
    expect(await lists).toEqual([[], []]);
    expect(await reentrantList.promise).toEqual([]);
    expect(await session.listDialogs()).toEqual([]);
    await expect
      .poll(() => observed.mock.calls.map(([event]) => event.phase))
      .toEqual(["raised", "closed"]);
  } finally {
    listVerified.resolve();
    listRelease.resolve();
    reentryRelease.resolve();
    await session.teardown();
  }
});

test("C-ATTN-08 a superseded Claude list timeout cannot retire a freshly raised request", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd });
  const held = await holdFirstGitLookup(lstat, cwd);
  try {
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
    const oldRead = session.listDialogs();
    await held.began;
    const observed = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
    session.on("dialog", observed);
    await expect.poll(() => observed.mock.calls.length).toBe(1);
    const raised = observed.mock.lastCall?.[0];
    expect(raised?.phase).toBe("raised");

    expect(await session.listDialogs()).toEqual([raised?.request]);
    expect(await oldRead).toEqual([raised?.request]);
    expect(observed).toHaveBeenCalledTimes(1);
  } finally {
    held.release();
    await session.teardown();
  }
});

test("C-ATTN-08 a failed first Claude publication preserves independent list verification", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd });
  const events = vi.fn();
  try {
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
    session.terminal.xterm.options.allowProposedApi = false;
    session.on("dialog", events);
    await new Promise<void>((resolve) => setImmediate(resolve));
    session.terminal.xterm.options.allowProposedApi = true;
    expect(events).not.toHaveBeenCalled();
    const [request] = await session.listDialogs();
    expect(request?.targetPath).toBe(cwd);
    await expect.poll(() => events.mock.calls).toEqual([[{ phase: "raised", request }]]);
  } finally {
    session.terminal.xterm.options.allowProposedApi = true;
    await session.teardown();
  }
});

test("C-ATTN-08 Claude closes its announced trust request on session teardown", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd });
  const events = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  session.on("dialog", events);
  try {
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
    await expect.poll(() => events.mock.calls.length).toBe(1);
    const [request] = await session.listDialogs();
    expect(request).toBeDefined();

    await session.teardown();
    expect(events.mock.calls).toEqual([
      [{ phase: "raised", request }],
      [{ phase: "closed", reason: "unavailable", request }],
    ]);
  } finally {
    await session.teardown();
  }
});
