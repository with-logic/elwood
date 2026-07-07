/**
 * Conformance tests for Claude resume option handling and defaults.
 * Covers PRD §5.2, §8.1, and §9.3.
 */

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resumeClaude, startClaude } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import {
  createSessionRecord,
  prepareStateDir,
  updateSessionResumeId,
  writeSessionRecord,
} from "../../src/state/store.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSession resume options", () => {
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
    setCommandRunnerForTests(() => ({ status: 0, stdout: "mystery build", stderr: "" }));
    const stops: string[] = [];
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
    expect(resumed.warnings).toMatchObject([{ code: "version_unparseable", agent: "claude" }]);
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

  test("C-API-29 resume forwards permissionMode into the launched command", async () => {
    const cwd = tempDir();
    const stateDir = join(cwd, ".elwood");
    prepareStateDir(stateDir);
    const record = updateSessionResumeId(
      createSessionRecord({ stateDir, cwd, id: "resume-perm" }),
      "claude",
      "claude-resume",
    );
    writeSessionRecord(record);
    installFakes();
    await resumeClaude({
      cwd,
      elwoodSessionId: "resume-perm",
      permissionMode: "bypassPermissions",
      allowedTools: ["Read"],
      disallowedTools: ["Bash", "WebSearch"],
    });
    expect(ptys[0]!.options.args.join(" ")).toContain("--permission-mode 'bypassPermissions'");
    expect(ptys[0]!.options.args.join(" ")).toContain("--allowedTools 'Read'");
    expect(ptys[0]!.options.args.join(" ")).toContain("--disallowedTools 'Bash,WebSearch'");
  });

  test("C-API-16 resume falls back to the default terminal size", async () => {
    const cwd = tempDir();
    const stateDir = join(cwd, ".elwood");
    prepareStateDir(stateDir);
    const record = updateSessionResumeId(
      createSessionRecord({ stateDir, cwd, id: "resume-no-size" }),
      "claude",
      "claude-resume",
    );
    writeSessionRecord(record);
    installFakes();
    const resumed = await resumeClaude({ cwd, elwoodSessionId: "resume-no-size" });
    expect(ptys[0]!.size).toEqual({ cols: 189, rows: 48 });
    expect(resumed.terminal.size).toEqual({ cols: 189, rows: 48 });
  });
});
