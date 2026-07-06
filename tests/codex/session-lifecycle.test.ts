/**
 * Conformance tests for Codex resume, live-only state, and errors.
 * Covers PRD §5.6, §8, §9, and §10.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { setCodexHookBridgeFactoryForTests } from "../../src/codex/session.ts";
import { resumeCodex, startCodex } from "../../src/index.ts";
import { setCommandRunnerForTests, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { createSessionRecord, prepareStateDir, writeSessionRecord } from "../../src/state/store.ts";
import { FakePty, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("CodexSession lifecycle", () => {
  test("C-API-10 persists Codex session id observed from SessionStart", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "SessionStart",
      session_id: "codex-session-1",
      cwd,
      model: "gpt-5.3-codex",
      source: "startup",
    });
    await session.stop();
    await resumeCodex({ cwd, elwoodSessionId: session.elwoodSessionId });
    expect(ptys).toHaveLength(2);
    expect(ptys[1]!.options.args.join(" ")).toContain("resume");
    expect(ptys[1]!.options.args.join(" ")).toContain("codex-session-1");
  });

  test("C-CODEX-07 fails when no Codex resume id was observed", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    await expect(
      resumeCodex({ cwd, elwoodSessionId: session.elwoodSessionId }),
    ).rejects.toMatchObject({ code: "resume_unavailable" });
  });

  test("C-STATE-10 rejects Claude records during Codex resume", async () => {
    const cwd = tempDir();
    const stateDir = join(cwd, ".elwood");
    prepareStateDir(stateDir);
    const record = createSessionRecord({ stateDir, cwd, id: "claude-record" });
    writeSessionRecord(record);
    await expect(
      resumeCodex({ cwd, elwoodSessionId: record.elwoodSessionId }),
    ).rejects.toMatchObject({ code: "adapter_mismatch" });
  });

  test("C-STATE-05 C-STATE-06 keeps Codex prompts and hooks live-only", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    await session.sendPrompt("SECRET_PROMPT");
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-1",
      cwd,
      model: "gpt-5.3-codex",
      turn_id: "turn-1",
      prompt: "SECRET_HOOK",
    });
    const dir = join(cwd, ".elwood", "sessions", session.elwoodSessionId);
    const persisted = readFileSync(join(dir, "session.json"), "utf8");
    expect(persisted).not.toContain("SECRET_PROMPT");
    expect(persisted).not.toContain("SECRET_HOOK");
  });

  test("C-LIFE-03 C-STATE-08 Codex kill and teardown update state", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const dir = join(cwd, ".elwood", "sessions", session.elwoodSessionId);
    await session.kill();
    expect(session.status).toBe("killed");
    expect(ptys[0]!.killSignals).toEqual(["SIGKILL"]);
    await expect(session.sendPrompt("after kill")).rejects.toMatchObject({
      code: "session_not_running",
    });
    expect(existsSync(join(dir, "session.json"))).toBe(true);
    await session.teardown();
    expect(session.status).toBe("torn_down");
    expect(ptys[0]!.killSignals).toEqual(["SIGKILL"]);
    expect(existsSync(dir)).toBe(false);
  });

  test("C-CODEX-05 missing Codex fails with typed error", async () => {
    installFakes();
    setCommandRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "",
      error: { code: "ENOENT", message: "missing" },
    }));
    await expect(startCodex({ cwd: tempDir() })).rejects.toMatchObject({
      code: "codex_not_found",
      message: expect.stringContaining("codex"),
    });
  });

  test("C-ERR-05 C-ERR-06 Codex startup failures are typed", async () => {
    installFakes();
    setPtyFactoryForTests(() => {
      throw new Error("pty failed");
    });
    await expect(startCodex({ cwd: tempDir() })).rejects.toMatchObject({
      code: "pty_start_failed",
    });
    resetFakes();
    installFakes();
    setCodexHookBridgeFactoryForTests(() => ({
      start: () => Promise.reject(new Error("bridge failed")),
      stop: () => Promise.resolve(),
    }));
    await expect(startCodex({ cwd: tempDir() })).rejects.toMatchObject({
      code: "hook_bridge_failed",
    });
  });

  test("C-ERR-05 C-ERR-06 non-Error startup failures preserve a string cause", async () => {
    installFakes();
    setPtyFactoryForTests(() => {
      // biome-ignore lint/style/useThrowOnlyError: exercises non-Error PTY failure handling
      throw "pty exploded";
    });
    await expect(startCodex({ cwd: tempDir() })).rejects.toMatchObject({
      code: "pty_start_failed",
      details: { cause: "pty exploded" },
    });
    resetFakes();
    installFakes();
    setCodexHookBridgeFactoryForTests(() => ({
      start: () => Promise.reject("bridge exploded"),
      stop: () => Promise.resolve(),
    }));
    await expect(startCodex({ cwd: tempDir() })).rejects.toMatchObject({
      code: "hook_bridge_failed",
      details: { cause: "bridge exploded" },
    });
  });

  test("C-CODEX-13 Codex exits during startup with a typed error", async () => {
    installFakes();
    setPtyFactoryForTests((options) => {
      const pty = new FakePty(options);
      ptys.push(pty);
      const timer = setInterval(() => {
        if (pty.exitHandlers.length === 0) return;
        clearInterval(timer);
        pty.emitExit({ exitCode: 12, signal: 15 });
      }, 0);
      return pty;
    });
    await expect(startCodex({ cwd: tempDir() })).rejects.toMatchObject({
      code: "codex_start_failed",
    });
  });
});
