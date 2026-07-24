/**
 * Conformance tests for Claude resume option handling and defaults.
 * Covers PRD §5.2, §8.1, and §9.3.
 */

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resumeClaude, startClaude } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update-once.ts";
import {
  createSessionRecord,
  prepareStateDir,
  sessionDir,
  updateSessionResumeId,
  writeSessionRecord,
} from "../../src/state/store.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSessionApi resume options", () => {
  test("C-API-03 C-LIFE-04 C-ERR-07 resume honors per-resume overrides", async () => {
    const cwd = tempDir();
    const stateDir = join(tempDir(), "state");
    installFakes();
    const session = await startClaude({ cwd, stateDir });
    await ptys[0]!.dispatchHook(
      session.elwoodSessionId,
      { hook_event_name: "SessionStart", session_id: "claude-resume", cwd, source: "startup" },
      stateDir,
    );
    await session.stop();
    // Resume must re-read the (now unparseable) version, not the cached good one.
    resetPreflightCacheForTests();
    setCommandRunnerForTests(() => ({ status: 0, stdout: "mystery build", stderr: "" }));
    const stops: string[] = [];
    // A non-strict resume proceeds despite an unparseable version; the version warning
    // is live-only (emitted during startup, never persisted), so it is not asserted here.
    const resumed = await resumeClaude({
      cwd,
      stateDir,
      elwoodSessionId: session.elwoodSessionId,
      initialSize: { cols: 50, rows: 20 },
      hooks: { Stop: (event) => void stops.push(event.hook_event_name) },
      hookTimeoutMs: 5_000,
      autotrust: true,
      strictVersionCheck: false,
    });
    expect(ptys[1]!.options.size).toEqual({ cols: 100, rows: 20 });
    await ptys[1]!.dispatchHook(
      resumed.elwoodSessionId,
      {
        hook_event_name: "InstructionsLoaded",
        session_id: "claude-resume",
        cwd,
        file_path: "/tmp/CLAUDE.md",
        memory_type: "Project",
        load_reason: "session_start",
      },
      stateDir,
    );
    expect(ptys[1]!.size).toEqual({ cols: 50, rows: 20 });
    await ptys[1]!.dispatchHook(
      resumed.elwoodSessionId,
      { hook_event_name: "Stop", session_id: "claude-resume", cwd },
      stateDir,
    );
    expect(stops).toEqual(["Stop"]);
  });

  test("C-API-03 resume discovers state from the calling process cwd", async () => {
    const cwd = realpathSync(tempDir());
    installFakes();
    const session = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "SessionStart",
      session_id: "claude-resume",
      cwd,
      source: "startup",
    });
    await session.stop();
    const previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      const resumed = await resumeClaude({ elwoodSessionId: session.elwoodSessionId });
      expect(resumed.cwd).toBe(cwd);
      expect(ptys[1]!.options.cwd).toBe(cwd);
    } finally {
      process.chdir(previousCwd);
    }
  });

  test("§8.1 a RELATIVE stateDir is resolved at the boundary, not re-resolved per op", async () => {
    // A relative stateDir must be made absolute ONCE at the resume boundary, so a
    // cwd change after resume returns cannot make a later derived path point elsewhere.
    const cwd = realpathSync(tempDir());
    installFakes();
    const previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      const first = await startClaude({ cwd, stateDir: ".elwood" }); // relative
      await ptys[0]!.dispatchHook(first.elwoodSessionId, {
        hook_event_name: "SessionStart",
        session_id: "claude-rel",
        cwd,
        source: "startup",
      });
      await first.stop();
      const resumed = await resumeClaude({
        elwoodSessionId: first.elwoodSessionId,
        stateDir: ".elwood",
      });
      // Change cwd AFTER resume resolves; teardown must still target the ORIGINAL
      // absolute location (resolved once), not a path relative to the new cwd.
      process.chdir(previousCwd);
      await expect(resumed.teardown()).resolves.toBeUndefined();
      expect(existsSync(join(cwd, ".elwood", "sessions", resumed.elwoodSessionId))).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  test("C-API-29 resume forwards permissionMode into the launched command", async () => {
    const cwd = tempDir();
    const stateDir = join(cwd, ".elwood");
    prepareStateDir(stateDir);
    const record = updateSessionResumeId(
      createSessionRecord({ cwd, id: "resume-perm" }),
      "claude",
      "claude-resume",
    );
    writeSessionRecord(record, sessionDir(stateDir, record.elwoodSessionId));
    installFakes();
    await resumeClaude({
      cwd,
      elwoodSessionId: "resume-perm",
      permissionMode: "bypassPermissions",
      allowedTools: ["Read"],
      disallowedTools: ["Bash", "WebSearch"],
      tools: ["Read", "Edit"],
    });
    expect(ptys[0]!.options.args.join(" ")).toContain("--permission-mode 'bypassPermissions'");
    expect(ptys[0]!.options.args.join(" ")).toContain("--allowedTools 'Read'");
    expect(ptys[0]!.options.args.join(" ")).toContain("--disallowedTools 'Bash,WebSearch'");
    expect(ptys[0]!.options.args.join(" ")).toContain("--tools 'Read,Edit'");
  });

  test("C-API-16 resume falls back to the default terminal size", async () => {
    const cwd = tempDir();
    const stateDir = join(cwd, ".elwood");
    prepareStateDir(stateDir);
    const record = updateSessionResumeId(
      createSessionRecord({ cwd, id: "resume-no-size" }),
      "claude",
      "claude-resume",
    );
    writeSessionRecord(record, sessionDir(stateDir, record.elwoodSessionId));
    installFakes();
    const resumed = await resumeClaude({ cwd, elwoodSessionId: "resume-no-size" });
    expect(ptys[0]!.size).toEqual({ cols: 189, rows: 48 });
    expect(resumed.terminal.size).toEqual({ cols: 189, rows: 48 });
  });
});
