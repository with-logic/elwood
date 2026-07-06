/**
 * Conformance tests for Codex resume option forwarding and defaults.
 * Covers PRD §5.6, §8, and §9.
 */

import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resumeCodex, startCodex } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { createSessionRecord, prepareStateDir, writeSessionRecord } from "../../src/state/store.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("CodexSession resume options", () => {
  test("C-API-10 resume forwards hooks, size, and safety options", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd, metadata: { ticket: "T-1" }, name: "demo" });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, sessionStart(cwd, "codex-session-1"));
    await ptys[0]!.dispatchHook(session.elwoodSessionId, sessionStart(cwd, "codex-session-2"));
    await session.stop();
    expect(readRecord(cwd, session.elwoodSessionId)).toMatchObject({
      metadata: { ticket: "T-1" },
      codex: { name: "demo", resumeId: "codex-session-1" },
    });
    const resumed = await resumeCodex({
      cwd,
      elwoodSessionId: session.elwoodSessionId,
      initialSize: { cols: 101, rows: 41 },
      hooks: { Stop: () => ({ decision: "block", reason: "Verify first." }) },
      hookTimeoutMs: 500,
      autotrust: true,
      strictVersionCheck: true,
    });
    expect(ptys[1]!.options.args.join(" ")).toContain("codex-session-1");
    expect(ptys[1]!.size).toEqual({ cols: 101, rows: 41 });
    const blocked = await ptys[1]!.dispatchHook(resumed.elwoodSessionId, stopEvent(cwd));
    expect(JSON.parse(blocked.stdout).decision).toBe("block");
    expect(resumed.status).toBe("running");
  });

  test("C-CODEX-07 resume falls back to defaults for cwd, state dir, and size", async () => {
    const cwd = realpathSync(tempDir());
    installFakes();
    setCommandRunnerForTests((_command, args) =>
      args.join(" ").includes("--help")
        ? { status: 0, stdout: "--dangerously-bypass-hook-trust", stderr: "" }
        : { status: 0, stdout: "unknown build", stderr: "" },
    );
    const stateDir = join(cwd, ".elwood");
    prepareStateDir(stateDir);
    const record = createSessionRecord({ stateDir, cwd, id: "codex-resume", adapter: "codex" });
    writeSessionRecord({ ...record, codex: { resumeId: "codex-session-9" } });
    const previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      const session = await resumeCodex({ elwoodSessionId: "codex-resume" });
      expect(session.cwd).toBe(cwd);
      expect(session.warnings).toMatchObject([{ code: "version_unparseable" }]);
      expect(ptys[0]!.size).toEqual({ cols: 189, rows: 48 });
      expect(session.terminal.size).toEqual({ cols: 189, rows: 48 });
    } finally {
      process.chdir(previousCwd);
    }
  });
});

function sessionStart(cwd: string, sessionId: string) {
  return {
    hook_event_name: "SessionStart",
    session_id: sessionId,
    cwd,
    model: "gpt-5.3-codex",
    source: "startup",
  };
}

function stopEvent(cwd: string) {
  return {
    hook_event_name: "Stop",
    session_id: "codex-1",
    cwd,
    model: "gpt-5.3-codex",
    turn_id: "turn-1",
    stop_hook_active: false,
  };
}

function readRecord(cwd: string, id: string) {
  return JSON.parse(readFileSync(join(cwd, ".elwood", "sessions", id, "session.json"), "utf8"));
}
