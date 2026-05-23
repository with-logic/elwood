/**
 * Conformance tests for Claude session resume, live-only state, and lifecycle.
 * Covers PRD §5, §7, §8, and §10.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resumeClaude, startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSession lifecycle", () => {
  test("C-STATE-02 C-STATE-04 resumes from caller-provided Elwood metadata", async () => {
    const cwd = tempDir();
    const stateDir = join(tempDir(), "state");
    installFakes();
    const session = await startClaude({ cwd, stateDir, initialSize: { cols: 44, rows: 12 } });
    await session.stop();
    const resumed = await resumeClaude({ cwd, stateDir, elwoodSessionId: session.elwoodSessionId });
    expect(resumed.elwoodSessionId).toBe(session.elwoodSessionId);
    expect(ptys).toHaveLength(2);
    expect(ptys[1]!.size).toEqual({ cols: 44, rows: 12 });
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

  test("C-LIFE-02 C-LIFE-03 C-STATE-07 C-STATE-08 lifecycle controls state", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const exits: number[] = [];
    const offExit = session.on("terminal:exit", (event) => exits.push(event.exitCode));
    const dir = join(cwd, ".elwood", "sessions", session.elwoodSessionId);
    await session.kill();
    expect(exits).toEqual([0]);
    offExit();
    expect(session.status).toBe("killed");
    expect(existsSync(join(dir, "session.json"))).toBe(true);
    await session.teardown();
    expect(session.status).toBe("torn_down");
    expect(existsSync(dir)).toBe(false);
  });

  test("C-PTY-06 process exit updates session status", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    ptys[0]!.emitExit({ exitCode: 7 });
    expect(session.status).toBe("exited");
  });
});
