/** Reentrant teardown cannot erase a resumed successor's shared state (C-API-20). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  currentCodexHookBridgeFactory,
  setCodexHookBridgeFactoryForTests,
} from "../../src/codex/session/bridge.ts";
import { resumeCodex, startCodex } from "../../src/index.ts";
import { readLoopDefinitions } from "../../src/state/loop-store.ts";
import { removeSessionIdentity } from "../../src/state/private-session.ts";
import {
  becomeReady,
  installFakes,
  ptys,
  readBridgeScript,
  resetFakes,
  tempDir,
} from "./helpers.ts";

afterEach(resetFakes);

test.each([
  "exit",
  "cleanup",
])("C-API-20 deferred teardown preserves a successor launched during %s", async (handoff) => {
  installFakes();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const factory = currentCodexHookBridgeFactory();
  let launches = 0;
  setCodexHookBridgeFactoryForTests((...args) => {
    const bridge = factory(...args);
    if (launches++ !== 0) return bridge;
    return {
      start: () => bridge.start(),
      stop: async () => {
        entered.resolve();
        await release.promise;
        await bridge.stop();
      },
    };
  });
  const cwd = tempDir();
  const path = join(cwd, "transcript.jsonl");
  writeFileSync(path, "");
  const session = await startCodex({ cwd });
  const loop = await session.createLoop({ mode: "fixed", intervalMs: 60_000, message: "retained" });
  await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
  let shutdown: Promise<void> | undefined;
  let successor: ReturnType<typeof resumeCodex> | undefined;
  session.on("codex:transcript", () => {
    shutdown ??= session.teardown();
  });
  session.on("terminal:exit", () => {
    if (handoff !== "exit") return;
    successor = resumeCodex({ cwd, elwoodSessionId: session.elwoodSessionId });
    void successor.catch(() => undefined);
  });
  writeFileSync(
    path,
    `${JSON.stringify({ type: "response_item", payload: { type: "reasoning" } })}\n`,
  );
  ptys[0]!.emitExit({ exitCode: 0 });
  expect(shutdown).toBeDefined();
  await entered.promise;
  if (handoff === "cleanup")
    successor = resumeCodex({ cwd, elwoodSessionId: session.elwoodSessionId });
  expect(successor).toBeDefined();
  const resumed = await successor!;
  try {
    const nextLoop = await resumed.createLoop({
      mode: "fixed",
      intervalMs: 60_000,
      message: "successor",
    });
    release.resolve();
    await shutdown;
    const dir = join(cwd, ".elwood", "sessions", session.elwoodSessionId);
    const bridgePath = join(dir, "hook-bridge.mjs");
    const bridge = readBridgeScript(bridgePath);
    const record = readFileSync(join(dir, "session.json"), "utf8");
    if (handoff === "exit")
      expect(await resumed.listLoops()).toContainEqual(expect.objectContaining({ id: loop.id }));
    const definitions = readLoopDefinitions(join(cwd, ".elwood"), session.elwoodSessionId);
    expect(definitions).toContainEqual(expect.objectContaining({ id: nextLoop.id }));
    expect(existsSync(bridge.socketPath)).toBe(true);
    await session.teardown();
    expect(readFileSync(join(dir, "session.json"), "utf8")).toBe(record);
    expect(readBridgeScript(bridgePath)).toEqual(bridge);
    expect(readLoopDefinitions(join(cwd, ".elwood"), session.elwoodSessionId)).toEqual(definitions);
    expect(existsSync(bridge.socketPath)).toBe(true);
    await expect(
      ptys[1]!.dispatchHook(resumed.elwoodSessionId, {
        hook_event_name: "SessionStart",
        session_id: "successor",
        cwd,
        source: "resume",
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(ptys[0]!.killSignals).toEqual([]);
  } finally {
    release.resolve();
    await resumed.teardown();
  }
});

test("C-API-20 a failed successor cannot restore stale teardown authority", async () => {
  installFakes();
  const cwd = tempDir();
  const stateDir = join(cwd, "private-state");
  const session = await startCodex({ cwd, stateDir });
  await ptys[0]!.dispatchHook(
    session.elwoodSessionId,
    {
      hook_event_name: "SessionStart",
      session_id: "resumable",
      cwd,
      source: "startup",
    },
    stateDir,
  );
  const loop = await session.createLoop({ mode: "fixed", intervalMs: 60_000, message: "retained" });
  await session.stop();
  const options = {
    cwd,
    stateDir,
    elwoodSessionId: session.elwoodSessionId,
    reasoningEffort: "high" as const,
  };
  Reflect.set(options, "reasoningEffort", "invalid");
  try {
    await expect(resumeCodex(options)).rejects.toMatchObject({
      code: "codex_invalid_reasoning_effort",
    });
    await session.teardown();
    expect(existsSync(join(stateDir, "sessions", session.elwoodSessionId, "session.json"))).toBe(
      true,
    );
    expect(readLoopDefinitions(stateDir, session.elwoodSessionId)).toContainEqual(
      expect.objectContaining({ id: loop.id }),
    );
  } finally {
    removeSessionIdentity(stateDir, session.elwoodSessionId, "codex");
  }
});
