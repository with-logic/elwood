/** Verify Claude discovery publishes a complete native prompt during startup (C-ATTN-08). */
import { execFileSync } from "node:child_process";
import { realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, assert, expect, test, vi } from "vitest";
import { ClaudeSession, type ElwoodDialogEvent, startClaude } from "../../src/index.ts";
import { currentPtyFactory, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { setStartupWaitMsForTests } from "../../src/runtime/startup/index.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { trustFrame } from "./workspace-trust-discovery-fixture.ts";

afterEach(() => {
  resetFakes();
});

test("C-ATTN-08 replays the active pre-return Claude disclosure", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = new ClaudeSession({ cwd, autotrust: false });
  const raised = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  session.on("dialog", raised);
  const launched = Promise.withResolvers<void>();
  const factory = currentPtyFactory();
  setPtyFactoryForTests((options) => {
    const pty = factory(options);
    launched.resolve();
    return pty;
  });
  setStartupWaitMsForTests(150);
  const started = session.start();
  try {
    await launched.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    ptys[0]!.emitData(trustFrame(cwd));
    expect(session.session).toBeUndefined();
    expect(raised).not.toHaveBeenCalled();

    const eager = await started;
    // Listing does not flush pending output (§5.13): it needs the trust frame rendered,
    // which the startup wait above does not guarantee.
    await eager.terminal.settled();
    const [request] = await eager.listDialogs();
    assert.isDefined(request);
    expect(request.targetPath).toBe(cwd);
    await expect.poll(() => raised.mock.calls).toEqual([[{ phase: "raised", request }]]);
    eager.on("dialog", raised);

    const late = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
    eager.on("dialog", late);
    expect(late).not.toHaveBeenCalled();
    await expect.poll(() => late.mock.calls).toEqual([[{ phase: "raised", request }]]);
    expect(raised).toHaveBeenCalledOnce();
    expect(await eager.listDialogs()).toEqual([request]);
    expect(ptys[0]!.writes).toEqual([]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 a Claude workspace request stays retired after Git scope is restored", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  execFileSync("git", ["-C", cwd, "init", "-q"]);
  const session = await startClaude({ cwd, autotrust: false });
  const events: ElwoodDialogEvent<"claude">[] = [];
  session.on("dialog", (event) => events.push(event));
  const pty = ptys[0]!;
  try {
    pty.emitData(trustFrame(cwd));
    await session.terminal.settled();
    const [request] = await session.listDialogs();
    assert.isDefined(request);
    expect(request.agent).toBe("claude");
    expect(request.targetScope).toBe("repository");
    await expect.poll(() => events).toEqual([{ phase: "raised", request }]);

    const marker = join(cwd, ".git");
    const backup = join(cwd, "former-git");
    renameSync(marker, backup);
    expect(await session.listDialogs()).toEqual([]);
    expect(events).toEqual([
      { phase: "raised", request },
      { phase: "closed", reason: "unavailable", request },
    ]);

    renameSync(backup, marker);
    pty.emitData(trustFrame(cwd));
    expect(await session.listDialogs()).toEqual([]);
    expect(events).toHaveLength(2);
    expect(session.status).toBe("blocked");
    expect(pty.writes).toEqual([]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 Claude revalidates scope changed during terminal data dispatch", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  execFileSync("git", ["-C", cwd, "init", "-q"]);
  const session = await startClaude({ cwd, autotrust: false });
  const raised = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  session.on("dialog", raised);
  const marker = join(cwd, ".git");
  const backup = join(cwd, "former-git");
  const off = session.on("terminal:data", ({ data }) => {
    if (data.includes("Accessing workspace:")) renameSync(marker, backup);
  });
  try {
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
    expect(await session.listDialogs()).toEqual([]);
    expect(raised).not.toHaveBeenCalled();
    expect(session.status).toBe("blocked");

    off();
    renameSync(backup, marker);
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
    expect(raised).not.toHaveBeenCalled();
    expect(await session.listDialogs()).toEqual([]);
    expect(ptys[0]!.writes).toEqual([]);
  } finally {
    await session.teardown();
  }
});

test.each([
  false,
  true,
])("C-ATTN-08 Claude replay tracks each registration until composer clearance (%s)", async (ready) => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = new ClaudeSession({ cwd, autotrust: false });
  const eager = await session.start();
  const pty = ptys[0]!;
  const live = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  const removed = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  const reentrant = vi.fn((): void => {
    session.off("dialog", reentrant);
  });
  session.on("dialog", live);
  try {
    pty.emitData(trustFrame(cwd));
    await eager.terminal.settled();
    expect(await eager.listDialogs()).toHaveLength(1);
    await expect.poll(() => live.mock.calls.length).toBe(1);
    const raised = live.mock.calls[0]?.[0];
    assert(raised?.phase === "raised");

    const off = eager.on("dialog", removed);
    off();
    session.on("dialog", reentrant);
    session.off("dialog", reentrant);
    session.on("dialog", reentrant);
    expect(reentrant).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    await expect.poll(() => reentrant.mock.calls).toEqual([[raised]]);
    expect(removed).not.toHaveBeenCalled();

    if (ready)
      await pty.dispatchHook(eager.elwoodSessionId, {
        hook_event_name: "InstructionsLoaded",
        session_id: "claude-1",
        cwd,
        file_path: "/tmp/CLAUDE.md",
        memory_type: "Project",
        load_reason: "session_start",
      });
    pty.emitData(`\x1b[2J\x1b[H${claudeTty(claudeComposer)}`);
    await eager.terminal.settled();
    expect(live.mock.calls.at(-1)).toEqual([
      { phase: "closed", reason: "cleared", request: raised.request },
    ]);
    expect(reentrant).toHaveBeenCalledOnce();
    expect(await session.listDialogs()).toEqual([]);
    expect(pty.writes).toEqual([]);
  } finally {
    await session.teardown();
  }
});
