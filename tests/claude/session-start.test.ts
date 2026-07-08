/**
 * Conformance tests for Claude session startup and PTY controls.
 * Covers PRD §5, §6, §8, §9, and §10.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSession startup and terminal control", () => {
  test("C-API-01 C-CLAUDE-02 C-LIFE-01 C-LIFE-05 C-STATE-01 C-API-16 starts with generated state and default terminal size", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, disallowedTools: ["AskUserQuestion"] });
    expect(session.elwoodSessionId.length).toBeGreaterThan(0);
    expect(session.cwd).toBe(cwd);
    expect(session.status).toBe("running");
    expect(session.warnings).toEqual([]);
    expect(ptys[0]!.options.cwd).toBe(cwd);
    expect(ptys[0]!.size).toEqual({ cols: 189, rows: 48 });
    expect(session.terminal.size).toEqual({ cols: 189, rows: 48 });
    const sessionDir = join(cwd, ".elwood", "sessions", session.elwoodSessionId);
    expect(existsSync(join(cwd, ".elwood", ".gitignore"))).toBe(true);
    expect(readFileSync(join(sessionDir, "claude-settings.json"), "utf8")).toContain(
      "hook-bridge.mjs",
    );
    expect(ptys[0]!.options.args.join(" ")).toContain("--disallowedTools 'AskUserQuestion'");
    expect(ptys[0]!.options.args).toContain("-l");
    expect(ptys[0]!.options.args).toContain("-i");
    expect(ptys).toHaveLength(1);
  });

  test("C-CLAUDE-12 forwards model to the --model launch flag", async () => {
    const cwd = tempDir();
    installFakes();
    await startClaude({ cwd, model: "claude-haiku-4-5" });
    expect(ptys[0]!.options.args.join(" ")).toContain("--model 'claude-haiku-4-5'");
  });

  test("C-STATE-04 persists caller metadata and session name", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, metadata: { ticket: "ELW-1" }, name: "main" });
    const record = JSON.parse(
      readFileSync(
        join(cwd, ".elwood", "sessions", session.elwoodSessionId, "session.json"),
        "utf8",
      ),
    );
    expect(record.metadata).toEqual({ ticket: "ELW-1" });
    expect(record.claude.name).toBe("main");
  });

  test("C-CLAUDE-01 preserves project-local Claude settings", async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    const settingsPath = join(cwd, ".claude", "settings.local.json");
    writeFileSync(settingsPath, '{"permissions":{"allow":["Read"]}}\n');
    installFakes();
    await startClaude({ cwd });
    expect(readFileSync(settingsPath, "utf8")).toBe('{"permissions":{"allow":["Read"]}}\n');
  });

  test("C-CLAUDE-10 autotrust answers Claude workspace prompts", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, autotrust: true });
    const activity: string[] = [];
    session.on("activity", (event) => activity.push(`${event.kind}:${event.label}`));
    ptys[0]!.emitData(
      "Quick safety check: Is this a project you created or one you trust?\r\n1. Yes, I trust this folder",
    );
    await flushTerminal();
    expect(ptys[0]!.writes).toEqual(["1\r"]);
    expect(activity).toContain("startup_prompt:workspace_trust");
  });

  test("C-ATTN-03 an auto-answered trust prompt does not block the session", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, autotrust: true });
    const attention: string[] = [];
    session.on("activity", (event) => {
      if (event.kind === "attention") attention.push(event.label);
    });
    ptys[0]!.emitData(
      "Quick safety check: Is this a project you created or one you trust?\r\n1. Yes, I trust this folder\r\n",
    );
    // Wait on the deterministic processed outcome — the autotrust answer being
    // written — rather than a fixed sleep, so the frame has been observed.
    await vi.waitFor(() => expect(ptys[0]!.writes).toContain("1\r"));
    // Elwood answered the prompt; it never surfaces as blocked/attention.
    expect(attention).toEqual([]);
    expect(session.status).not.toBe("blocked");
  });

  test("C-ATTN-03 an unanswered trust prompt blocks with the trust label", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, autotrust: false });
    const attention: string[] = [];
    session.on("activity", (event) => {
      if (event.kind === "attention") attention.push(event.label);
    });
    ptys[0]!.emitData(
      "Quick safety check: Is this a project you created or one you trust?\r\n1. Yes, I trust this folder\r\n",
    );
    await expect.poll(() => session.status).toBe("blocked");
    expect(attention).toEqual(["claude-trust-prompt"]);
    // Elwood did not answer on the caller's behalf.
    expect(ptys[0]!.writes).toEqual([]);
  });

  test("C-ERR-07 version warnings are captured when non-strict parsing fails", async () => {
    const cwd = tempDir();
    installFakes();
    setCommandRunnerForTests(() => ({ status: 0, stdout: "unknown build", stderr: "" }));
    const session = await startClaude({ cwd });
    const replayedWarnings: string[] = [];
    const replayedActivity: string[] = [];
    session.on("warning", (event) => replayedWarnings.push(event.code));
    session.on("activity", (event) => replayedActivity.push(event.kind));
    expect(session.warnings).toMatchObject([{ code: "version_unparseable", agent: "claude" }]);
    expect(replayedWarnings).toEqual(["version_unparseable"]);
    expect(replayedActivity).toEqual(["warning"]);
  });

  test("C-API-05 C-API-06 C-API-07 C-API-13 C-API-19 sends prompts and queued messages", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await session.sendPrompt("hello\nworld");
    const queued = session.sendMessage("again");
    expect(ptys[0]!.writes).toEqual(["\u001b[200~hello\nworld\u001b[201~"]);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd,
    });
    await queued;
    expect(ptys[0]!.writes.filter((w) => w !== "\r")[1]).toBe("\u001b[200~again\u001b[201~");
  });

  test("C-PTY-03 C-PTY-04 C-PTY-05 emits terminal data, raw keys, and resize", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const seen: string[] = [];
    const activity: string[] = [];
    const offPtyData = ptys[0]!.onData(() => {});
    const offPtyExit = ptys[0]!.onExit(() => {});
    offPtyData();
    offPtyExit();
    ptys[0]!.emitData("early");
    await flushTerminal();
    const unsubscribe = session.on("terminal:data", (event) => seen.push(event.data));
    session.on("activity", (event) => activity.push(event.kind));
    session.off("terminal:data", () => {});
    ptys[0]!.emitData("abc");
    await flushTerminal();
    unsubscribe();
    ptys[0]!.emitData("ignored");
    await session.sendKeys("x");
    await session.resize({ cols: 80, rows: 24 });
    ptys[0]!.emitExit({ exitCode: 7 });
    expect(seen).toEqual(["early", "abc"]);
    expect(ptys[0]!.writes).toEqual(["x"]);
    expect(ptys[0]!.size).toEqual({ cols: 80, rows: 24 });
    expect(activity).toContain("terminal_exit");
  });
});

function flushTerminal(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}
