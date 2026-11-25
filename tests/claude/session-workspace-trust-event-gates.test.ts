/** Check Claude event publication without additional PTY output or native snapshot access (C-ATTN-08). */
import { realpathSync } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeSessionImpl } from "../../src/claude/session/instance.ts";
import { ClaudeWorkspaceTrustDiscovery } from "../../src/claude/workspace-trust/discovery.ts";
import { type ElwoodDialogEvent, startClaude } from "../../src/index.ts";
import { settledNativeSnapshot } from "../../src/terminal/cursor.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";
import { holdFirstGitLookup } from "../helpers/hold-git-lookup.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { trustFrame } from "./workspace-trust-discovery-fixture.ts";

vi.mock("node:fs/promises", { spy: true });
vi.mock("../../src/terminal/cursor.ts", { spy: true });
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(lstat).mockReset();
  vi.mocked(settledNativeSnapshot).mockReset();
  vi.restoreAllMocks();
  resetFakes();
});

test("C-ATTN-08 Claude announces a raw takeover of an already settled menu", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd, autotrust: true });
  const observed = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  session.on("dialog", observed);
  try {
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
    expect(observed).not.toHaveBeenCalled();
    await session.sendKeys("x");
    await expect
      .poll(() => observed.mock.calls)
      .toEqual([[{ phase: "raised", request: expect.objectContaining({ targetPath: cwd }) }]]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 a Claude snapshot failure retires retained replay without rejection", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd });
  const live = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  session.on("dialog", live);
  try {
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
    await expect.poll(() => live.mock.calls.length).toBe(1);

    session.terminal.xterm.options.allowProposedApi = false;
    const late = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
    session.on("dialog", late);
    await expect
      .poll(() => late.mock.calls)
      .toEqual([[{ phase: "closed", reason: "unavailable", request: expect.any(Object) }]]);
  } finally {
    session.terminal.xterm.options.allowProposedApi = true;
    await session.teardown();
  }
});

test("C-ATTN-08 stalled Claude publication checks resume only for the latest native frame", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd });
  const render = async (screen: string) => {
    ptys[0]!.emitData(screen);
    await session.terminal.settled();
  };
  const menu = trustFrame(cwd);
  const other = menu.replace("❯ No", "  No").replace("   Yes", " ❯ Yes");
  const latest = menu.replace(
    "❯ No, exit\r\n   Yes, I trust this folder",
    "❯ Yes, I trust this folder\r\n   No, exit",
  );
  const observed = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  const held: Awaited<ReturnType<typeof holdFirstGitLookup>>[] = [];
  session.on("dialog", observed);
  try {
    for (const screen of [menu, other]) {
      const lookup = await holdFirstGitLookup(lstat, cwd);
      held.push(lookup);
      await render(screen);
      await lookup.began;
    }

    const reads = vi.mocked(stat).mock.calls.length;
    await render(menu);
    await render(latest);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(vi.mocked(stat)).toHaveBeenCalledTimes(reads);
    expect(observed).not.toHaveBeenCalled();

    held[0]?.release();
    await expect
      .poll(() => observed.mock.lastCall?.[0])
      .toMatchObject({
        phase: "raised",
        request: { choices: [{ label: "Yes, I trust this folder" }, { label: "No, exit" }] },
      });
    expect(observed).toHaveBeenCalledOnce();
  } finally {
    for (const lookup of held) lookup.release();
    await session.teardown();
  }
});

test("C-ATTN-08 a canceled Claude replay cannot retire another subscriber's request", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd });
  const live = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  session.on("dialog", live);
  try {
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
    await expect.poll(() => live.mock.calls.length).toBe(1);
    const initial = await session.listDialogs();
    const held = await holdFirstGitLookup(lstat, cwd);
    const late = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const off = session.on("dialog", late);
    try {
      await held.began;
      off();
      await vi.advanceTimersByTimeAsync(500);
      vi.useRealTimers();
      expect(await session.listDialogs()).toEqual(initial);
      expect(live).toHaveBeenCalledTimes(1);
      expect(late).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      held.release();
    }
  } finally {
    await session.teardown();
  }
});

test.each([
  "throws",
  "unsettled",
  "other frame",
  "cleared",
] as const)("C-ATTN-08 optional Claude close classification (%s) cannot interrupt readiness", async (failure) => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd });
  const observed = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  const pty = ptys[0]!;
  session.on("dialog", observed);
  try {
    pty.emitData(trustFrame(cwd));
    await session.terminal.settled();
    await expect.poll(() => observed.mock.calls.length).toBe(1);
    await pty.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "claude-1",
      cwd,
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
    const previousFrame = settledNativeSnapshot(session.terminal);
    const complete = vi.spyOn(ClaudeSessionImpl.prototype, "completeInitialReady");
    const { endStartup } = ClaudeWorkspaceTrustDiscovery.prototype;
    vi.spyOn(ClaudeWorkspaceTrustDiscovery.prototype, "reconcile").mockReturnValue(undefined);
    vi.spyOn(ClaudeWorkspaceTrustDiscovery.prototype, "endStartup").mockImplementationOnce(
      function (this: ClaudeWorkspaceTrustDiscovery) {
        if (failure !== "cleared") {
          vi.mocked(settledNativeSnapshot).mockImplementationOnce(() => {
            if (failure === "throws") throw new Error("Optional snapshot unavailable");
            return failure === "other frame" ? previousFrame : undefined;
          });
        }
        endStartup.call(this);
      },
    );
    pty.emitData(`\x1b[2J\x1b[H${claudeTty(claudeComposer)}`);
    await session.terminal.settled();
    expect(complete).toHaveBeenCalledOnce();
    expect(session.status).toBe("ready");
    await expect
      .poll(() => observed.mock.lastCall?.[0])
      .toMatchObject({
        phase: "closed",
        reason: failure === "cleared" ? "cleared" : "unavailable",
      });
  } finally {
    await session.teardown();
  }
});
