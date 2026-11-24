/** Failed startup restores published predecessor files and hook delivery (C-API-20). */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { setCodexHookBridgeFactoryForTests } from "../../src/codex/session/bridge.ts";
import { startCodexWithId } from "../../src/codex/session/index.ts";
import { resumeCodex, startCodex } from "../../src/index.ts";
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
  const live = await startCodex({ cwd });
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
      setCodexHookBridgeFactoryForTests(() => ({
        start: () => Promise.reject(new Error("bridge failed")),
        stop: () => Promise.resolve(),
      }));
    else
      setPtyFactoryForTests(() => {
        throw new Error("PTY failed");
      });
    await expect(
      resumeCodex({ cwd, elwoodSessionId: id, sandbox: "read-only" }),
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
  { phase: "failed", fails: true },
  { phase: "successful", fails: false },
])("C-STATE-15 $phase startup defers its locator until launch commit", async ({ fails }) => {
  installFakes();
  const cwd = tempDir();
  const stateDir = join(cwd, "state");
  const id = "pending-hook";
  const dir = join(stateDir, "sessions", id);
  const locator = join(dir, "codex-rollout.json");
  const rollout = join(cwd, "transcript.jsonl");
  const launched = Promise.withResolvers<void>();
  const factory = currentPtyFactory();
  setPtyFactoryForTests((options) => {
    const pty = factory(options);
    launched.resolve();
    return pty;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  setStartupWaitMsForTests(1_000);
  const starting = startCodexWithId({ cwd, stateDir }, id).then(
    (session) => ({ session }),
    (error: unknown) => ({ error }),
  );
  try {
    await launched.promise;
    await ptys[0]!.dispatchHook(
      id,
      {
        hook_event_name: "SessionStart",
        session_id: "pending-id",
        transcript_path: rollout,
        cwd,
        source: "startup",
      },
      stateDir,
    );
    expect(readSessionRecord(stateDir, id).codex.resumeId).toBe("pending-id");
    expect(existsSync(locator)).toBe(false);
    if (fails) ptys[0]!.emitExit({ exitCode: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    if (fails) {
      expect(await starting).toMatchObject({ error: { code: "codex_start_failed" } });
      expect(existsSync(join(dir, "session.json"))).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
      expect(hasLaunchOwner(dir)).toBe(false);
    } else {
      expect(await starting).toHaveProperty("session");
      expect(JSON.parse(readFileSync(locator, "utf8"))).toEqual({
        nativeSessionId: "pending-id",
        path: rollout,
      });
    }
  } finally {
    ptys[0]?.emitExit({ exitCode: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await starting;
    vi.useRealTimers();
    if ("session" in result) await result.session.teardown();
    removeSessionIdentity(stateDir, id, "codex");
  }
});
