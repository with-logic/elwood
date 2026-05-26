/**
 * Conformance tests for Claude session startup and PTY controls.
 * Covers PRD §5, §6, §8, §9, and §10.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startClaude } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSession startup and terminal control", () => {
  test("C-API-01 C-API-16 starts with generated state and default terminal size", async () => {
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

  test("C-ERR-07 version warnings are captured when non-strict parsing fails", async () => {
    const cwd = tempDir();
    installFakes();
    setCommandRunnerForTests(() => ({ status: 0, stdout: "unknown build", stderr: "" }));
    const session = await startClaude({ cwd });
    expect(session.warnings).toMatchObject([{ code: "version_unparseable", agent: "claude" }]);
  });

  test("C-API-06 C-API-13 sends multiline prompts and adapter-neutral messages", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await session.sendPrompt("hello\nworld");
    await session.sendMessage("again");
    expect(ptys[0]!.writes).toEqual([
      "\u001b[200~hello\nworld\u001b[201~\r",
      "\u001b[200~again\u001b[201~\r",
    ]);
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
    expect(seen).toEqual(["abc"]);
    expect(ptys[0]!.writes).toEqual(["x"]);
    expect(ptys[0]!.size).toEqual({ cols: 80, rows: 24 });
    expect(activity).toContain("terminal_exit");
  });
});

function flushTerminal(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}
