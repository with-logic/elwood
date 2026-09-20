/**
 * Conformance tests for Codex resume option forwarding and defaults.
 * Covers PRD §5.6, §8, and §9.
 */

import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resumeCodex, startCodex } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { safeSessionDir } from "../../src/state/files.ts";
import { createSessionRecord, prepareStateDir, writeSessionRecord } from "../../src/state/store.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("CodexSessionApi resume options", () => {
  test("C-API-10 resume forwards hooks, size, and safety options", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, sessionStart(cwd, "codex-session-1"));
    await ptys[0]!.dispatchHook(session.elwoodSessionId, sessionStart(cwd, "codex-session-2"));
    await session.stop();
    // §8: the minimal record persists only the resume id, never metadata/name.
    expect(readRecord(cwd, session.elwoodSessionId)).toMatchObject({
      codex: { resumeId: "codex-session-1" },
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

  test("C-API-28 resume reaches ready on the first composer marker (no SessionStart needed)", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, sessionStart(cwd, "codex-session-1"));
    await session.stop();
    // Resume, then render a composer frame WITHOUT dispatching SessionStart (the CLI
    // does not re-fire it on resume). On resume the composer marker is a safe readiness
    // signal, so the session reaches ready without waiting out the deadline.
    const resumed = await resumeCodex({ cwd, elwoodSessionId: session.elwoodSessionId });
    expect(resumed.status).not.toBe("ready"); // not ready until the composer renders
    ptys[1]!.emitData("\u001b[2J\u001b[H› "); // clear + home + composer marker
    await resumed.terminal.settled(); // flush the write -> render -> readiness chain
    await new Promise((r) => setImmediate(r));
    expect(resumed.status).toBe("ready");
  });

  test("C-API-28 resume does NOT mark ready on a blocking dialog whose caret looks like the composer", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, sessionStart(cwd, "codex-session-1"));
    await session.stop();
    const resumed = await resumeCodex({ cwd, elwoodSessionId: session.elwoodSessionId });
    // The first resume frame is an approval DIALOG — its `›` caret is byte-identical to
    // the composer marker. Readiness must NOT latch, or a draining Enter could approve it.
    ptys[1]!.emitData(
      "\u001b[2J\u001b[HWould you like to run the following command?\r\n› 1. Yes\r\nPress enter to confirm or esc to cancel",
    );
    await resumed.terminal.settled();
    await new Promise((r) => setImmediate(r));
    expect(resumed.status).not.toBe("ready"); // waits for the dialog to clear
  });

  test("C-TURN-03 a turn queued during resume ends without Stop and the next message drains", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, sessionStart(cwd, "codex-session-1"));
    await session.stop();
    const resumed = await resumeCodex({ cwd, elwoodSessionId: session.elwoodSessionId });
    const first = resumed.sendMessage("queued during resume");
    ptys[1]!.emitData("\u001b[2J\u001b[H› ");
    await first;
    expect(resumed.status).toBe("running");
    // Without Stop, distinct native busy/idle frames retain the end edge and reopen the queue.
    ptys[1]!.emitData("\u001b[2J\u001b[H• Working (3s • esc to interrupt)\r\n› ");
    await resumed.terminal.settled(); // The busy and idle states are distinct observed frames.
    expect(resumed.terminal.snapshot().lines[0]).toBe("• Working (3s • esc to interrupt)");
    ptys[1]!.emitData("\u001b[2J\u001b[H› ");
    await expect.poll(() => resumed.status).toBe("ready");
    await resumed.sendMessage("second message drains");
    expect(ptys[1]!.writes.join("")).toContain("second message drains");
  });

  test("C-API-29 resume forwards sandbox and approvalPolicy into the launched command", async () => {
    const cwd = realpathSync(tempDir());
    installFakes();
    const stateDir = join(cwd, ".elwood");
    prepareStateDir(stateDir);
    const record = createSessionRecord({ cwd, id: "codex-priv", adapter: "codex" });
    writeSessionRecord(
      { ...record, codex: { resumeId: "codex-session-9" } },
      safeSessionDir(stateDir, "codex-priv"),
    );
    const resumed = await resumeCodex({
      cwd,
      elwoodSessionId: "codex-priv",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      reasoningEffort: "xhigh", // re-supplied per resume (C-CODEX-21), not persisted
    });
    const command = ptys[0]!.options.args.join(" ");
    expect(command).toContain("--sandbox 'danger-full-access'");
    expect(command).toContain("--ask-for-approval 'never'");
    expect(command).toContain('model_reasoning_effort="xhigh"');
    expect(resumed.status).toBe("running");
  });

  test("C-API-32 codex resume defaults sandbox and approval from the record", async () => {
    const cwd = realpathSync(tempDir());
    installFakes();
    const stateDir = join(cwd, ".elwood");
    prepareStateDir(stateDir);
    const record = createSessionRecord({ cwd, id: "posture-codex", adapter: "codex" });
    writeSessionRecord(
      {
        ...record,
        codex: {
          resumeId: "codex-session-10",
          launch: { sandbox: "workspace-write", approvalPolicy: "never" },
        },
      },
      safeSessionDir(stateDir, "posture-codex"),
    );
    await resumeCodex({ cwd, elwoodSessionId: "posture-codex" });
    const command = ptys[0]!.options.args.join(" ");
    expect(command).toContain("--sandbox 'workspace-write'");
    expect(command).toContain("--ask-for-approval 'never'");
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
    const record = createSessionRecord({ cwd, id: "codex-resume", adapter: "codex" });
    writeSessionRecord(
      { ...record, codex: { resumeId: "codex-session-9" } },
      safeSessionDir(stateDir, "codex-resume"),
    );
    const previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      // No cwd/stateDir/size: falls back to process.cwd(), the default state dir, and
      // the default size. The unparseable version is live-only, never persisted (§8).
      const session = await resumeCodex({ elwoodSessionId: "codex-resume" });
      expect(session.cwd).toBe(cwd);
      expect(ptys[0]!.size).toEqual({ cols: 189, rows: 48 });
      expect(session.terminal.size).toEqual({ cols: 189, rows: 48 });
      expect(readRecord(cwd, "codex-resume")).not.toHaveProperty("warnings");
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
