/** Failed startup restores published predecessor files and hook delivery (C-API-20). */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { setHookBridgeFactoryForTests } from "../../src/claude/session/bridge.ts";
import { startClaudeWithId } from "../../src/claude/session/index.ts";
import { resumeClaude, startClaude } from "../../src/index.ts";
import { currentPtyFactory, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { setStartupWaitMsForTests } from "../../src/runtime/startup/index.ts";
import { hasLaunchOwner } from "../../src/state/launch-ownership.ts";
import { removeSessionIdentity } from "../../src/state/private-session.ts";
import { readSessionRecord } from "../../src/state/store.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test.each([
  "bridge",
  "pty",
])("C-API-20 a failed %s restores predecessor state and a usable bridge", async (phase) => {
  installFakes();
  const cwd = tempDir();
  const live = await startClaude({ cwd });
  const id = live.elwoodSessionId;
  await ptys[0]!.dispatchHook(id, {
    hook_event_name: "SessionStart",
    session_id: "old",
    cwd,
    source: "startup",
  });
  const dir = join(cwd, ".elwood", "sessions", id);
  const files = readdirSync(dir);
  const before = files.map((file) => readFileSync(join(dir, file), "utf8"));
  try {
    if (phase === "bridge")
      setHookBridgeFactoryForTests(() => ({
        start: () => Promise.reject(new Error("bridge failed")),
        stop: () => Promise.resolve(),
      }));
    else
      setPtyFactoryForTests(() => {
        throw new Error("PTY failed");
      });
    await expect(
      resumeClaude({ cwd, elwoodSessionId: id, permissionMode: "plan" }),
    ).rejects.toMatchObject({
      code: phase === "bridge" ? "hook_bridge_failed" : "pty_start_failed",
    });
    expect(readdirSync(dir)).toEqual(files);
    expect(files.map((file) => readFileSync(join(dir, file), "utf8"))).toEqual(before);
    await expect(
      ptys[0]!.dispatchHook(id, {
        hook_event_name: "SessionStart",
        session_id: "old",
        cwd,
        source: "startup",
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
  } finally {
    await live.teardown();
  }
});

test.each([
  false,
  true,
])("C-API-20 failed pending startup rolls back its hook record after moved=%s", async (move) => {
  installFakes();
  const cwd = tempDir();
  const stateDir = join(cwd, "state");
  const id = "pending-hook";
  const moved = join(tempDir(), "moved");
  const dir = join(stateDir, "sessions", id);
  const launched = Promise.withResolvers<void>();
  const factory = currentPtyFactory();
  setPtyFactoryForTests((options) => {
    const pty = factory(options);
    launched.resolve();
    return pty;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  setStartupWaitMsForTests(1_000);
  const starting = startClaudeWithId({ cwd, stateDir }, id).catch((error: unknown) => error);
  try {
    await launched.promise;
    if (move) {
      renameSync(cwd, moved);
      mkdirSync(cwd);
    }
    const physicalState = move ? join(moved, "state") : stateDir;
    await ptys[0]!.dispatchHook(
      id,
      { hook_event_name: "SessionStart", session_id: "pending-id", cwd, source: "startup" },
      physicalState,
    );
    expect(readSessionRecord(physicalState, id).claude.resumeId).toBe("pending-id");
    ptys[0]!.emitExit({ exitCode: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await starting).toMatchObject({ code: "claude_start_failed" });
    const physicalDir = join(physicalState, "sessions", id);
    expect(existsSync(join(physicalDir, "session.json"))).toBe(false);
    expect(readdirSync(physicalDir)).toEqual([]);
    expect(hasLaunchOwner(dir)).toBe(false);
  } finally {
    ptys[0]?.emitExit({ exitCode: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    await starting;
    vi.useRealTimers();
    if (existsSync(moved)) {
      rmSync(cwd, { recursive: true });
      renameSync(moved, cwd);
    }
    removeSessionIdentity(stateDir, id, "claude");
  }
});
