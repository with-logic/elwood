/**
 * Conformance tests for Claude session resume, live-only state, and lifecycle.
 * Covers PRD §5, §7, §8, and §10.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resumeClaude, startClaude } from "../../src/index.ts";
import { createSessionRecord, prepareStateDir, writeSessionRecord } from "../../src/state/store.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSession lifecycle", () => {
  test("C-API-03 C-LIFE-04 C-STATE-02 C-STATE-04 resumes from caller-provided Elwood metadata", async () => {
    const cwd = tempDir();
    const stateDir = join(tempDir(), "state");
    installFakes();
    const session = await startClaude({ cwd, stateDir, initialSize: { cols: 44, rows: 12 } });
    await ptys[0]!.dispatchHook(
      session.elwoodSessionId,
      {
        hook_event_name: "SessionStart",
        session_id: "claude-resume-id",
        cwd,
        source: "startup",
      },
      stateDir,
    );
    await session.stop();
    const resumed = await resumeClaude({ cwd, stateDir, elwoodSessionId: session.elwoodSessionId });
    expect(resumed.elwoodSessionId).toBe(session.elwoodSessionId);
    expect(ptys).toHaveLength(2);
    expect(ptys[1]!.size).toEqual({ cols: 44, rows: 12 });
    expect(ptys[1]!.options.args.join(" ")).toContain("--resume 'claude-resume-id'");
  });

  test("C-STATE-10 rejects Codex records during Claude resume", async () => {
    const cwd = tempDir();
    const stateDir = join(cwd, ".elwood");
    prepareStateDir(stateDir);
    const record = createSessionRecord({
      stateDir,
      cwd,
      id: "codex-record",
      adapter: "codex",
    });
    writeSessionRecord(record);
    await expect(
      resumeClaude({ cwd, elwoodSessionId: record.elwoodSessionId }),
    ).rejects.toMatchObject({ code: "adapter_mismatch" });
  });

  test("C-CLAUDE-08 C-STATE-02 rejects Claude resume before Claude publishes a session id", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await expect(
      resumeClaude({ cwd, elwoodSessionId: session.elwoodSessionId }),
    ).rejects.toMatchObject({ code: "resume_unavailable" });
  });

  test("C-STATE-05 C-STATE-06 keeps prompts, terminal data, and hook payloads live-only", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await session.sendPrompt("SECRET_PROMPT");
    ptys[0]!.emitData("SECRET_TERMINAL");
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-1",
      cwd,
      prompt: "SECRET_HOOK",
    });
    const dir = join(cwd, ".elwood", "sessions", session.elwoodSessionId);
    const persisted = readdirSync(dir)
      .filter((file) => file !== "hook.sock")
      .map((file) => readFileSync(join(dir, file), "utf8"))
      .join("\n");
    expect(persisted).not.toContain("SECRET_PROMPT");
    expect(persisted).not.toContain("SECRET_TERMINAL");
    expect(persisted).not.toContain("SECRET_HOOK");
  });

  test("C-API-04 C-LIFE-02 C-LIFE-03 C-STATE-07 C-STATE-08 C-STATE-09 lifecycle controls state", async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    const claudeSettings = join(cwd, ".claude", "settings.local.json");
    writeFileSync(claudeSettings, '{"permissions":{"allow":["Read"]}}\n');
    installFakes();
    const session = await startClaude({ cwd });
    const exits: number[] = [];
    const offExit = session.on("terminal:exit", (event) => exits.push(event.exitCode));
    const dir = join(cwd, ".elwood", "sessions", session.elwoodSessionId);
    await session.kill();
    expect(exits).toEqual([0]);
    offExit();
    expect(session.status).toBe("killed");
    expect(ptys[0]!.killSignals).toEqual(["SIGKILL"]);
    expect(existsSync(join(dir, "session.json"))).toBe(true);
    await session.teardown();
    expect(session.status).toBe("torn_down");
    expect(ptys[0]!.killSignals).toEqual(["SIGKILL"]);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(claudeSettings, "utf8")).toContain("Read");
  });

  test("C-PTY-06 process exit updates session status", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    ptys[0]!.emitExit({ exitCode: 7 });
    expect(session.status).toBe("exited");
    await expect(session.sendPrompt("after exit")).rejects.toMatchObject({
      code: "session_not_running",
    });
    await expect(session.resize({ cols: 80, rows: 24 })).rejects.toMatchObject({
      code: "session_not_running",
    });
  });
});
