/**
 * Conformance tests for Codex session startup and terminal controls.
 * Covers PRD §5.5, §5.7, §7A, and §9.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("CodexSession startup and terminal control", () => {
  test("C-API-09 C-CODEX-01 C-CODEX-02 starts Codex with generated hook config", async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    const codexConfig = join(cwd, ".codex", "config.toml");
    writeFileSync(codexConfig, 'model="unchanged"\n');
    installFakes();
    const session = await startCodex({ cwd, model: "gpt-5.3-codex", sandbox: "workspace-write" });
    const command = ptys[0]!.options.args.join(" ");
    expect(session.elwoodSessionId.length).toBeGreaterThan(0);
    expect(session.cwd).toBe(cwd);
    expect(session.status).toBe("running");
    expect(ptys[0]!.size).toEqual({ cols: 189, rows: 48 });
    expect(session.terminal.size).toEqual({ cols: 189, rows: 48 });
    expect(command).toContain("exec codex");
    expect(command).toContain("--cd");
    expect(command).toContain("--model");
    expect(command).toContain("--sandbox");
    expect(command).toContain("--dangerously-bypass-hook-trust");
    expect(command).toContain("hookTrust");
    expect(command).toContain("hooks.Stop");
    expect(existsSync(join(cwd, ".elwood", ".gitignore"))).toBe(true);
    expect(readFileSync(codexConfig, "utf8")).toBe('model="unchanged"\n');
  });

  test("C-CODEX-06 trusts hooks through the TUI prompt when bypass is unsupported", async () => {
    const cwd = tempDir();
    installFakes({ supportsHookTrustBypass: false });
    await startCodex({ cwd });
    expect(ptys[0]!.options.args.join(" ")).not.toContain("--dangerously-bypass-hook-trust");
    ptys[0]!.emitData("Hooks need review\r\n  1. Review hooks\r\n› 2. Trust all and continue");
    await flushTerminal();
    expect(ptys[0]!.writes).toEqual(["2"]);
  });

  test("C-CODEX-11 autotrust answers Codex directory prompts", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd, autotrust: true });
    const activity: string[] = [];
    session.on("activity", (event) => activity.push(`${event.kind}:${event.label}`));
    ptys[0]!.emitData("Do you trust the contents of this directory?\r\n› 1. Yes, continue");
    await flushTerminal();
    expect(ptys[0]!.writes).toEqual(["1\r"]);
    expect(activity).toContain("startup_prompt:workspace_trust");
  });

  test("C-ERR-07 version warnings are captured when non-strict parsing fails", async () => {
    const cwd = tempDir();
    installFakes();
    setCommandRunnerForTests((_command, args) =>
      args.join(" ").includes("--help")
        ? { status: 0, stdout: "--dangerously-bypass-hook-trust", stderr: "" }
        : { status: 0, stdout: "unknown build", stderr: "" },
    );
    const session = await startCodex({ cwd });
    const replayedWarnings: string[] = [];
    const replayedActivity: string[] = [];
    session.on("warning", (event) => replayedWarnings.push(event.code));
    session.on("activity", (event) => replayedActivity.push(event.kind));
    expect(session.warnings).toMatchObject([{ code: "version_unparseable", agent: "codex" }]);
    expect(replayedWarnings).toEqual(["version_unparseable"]);
    expect(replayedActivity).toEqual(["warning"]);
  });

  test("C-CODEX-12 skips Codex TUI update prompts", async () => {
    const cwd = tempDir();
    installFakes();
    await startCodex({ cwd });
    ptys[0]!.emitData("Update available\r\n  1. Update now\r\n  2. Continue without updating");
    await flushTerminal();
    expect(ptys[0]!.writes).toEqual(["2"]);
  });

  test("C-API-14 C-CODEX-09 emits typed Codex MCP startup warnings", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const warnings: string[] = [];
    const activity: string[] = [];
    session.on("warning", (event) => warnings.push(event.code));
    session.on("activity", (event) => activity.push(event.kind));
    ptys[0]!.emitData(
      "The linear MCP server is not logged in. Run `codex mcp login linear`.\nMCP startup incomplete (failed: linear)",
    );
    ptys[0]!.emitData("MCP startup incomplete (failed: linear)");
    await flushTerminal();
    expect(warnings).toEqual(["mcp_server_not_logged_in", "mcp_startup_incomplete"]);
    expect(session.warnings[0]).toMatchObject({ mcpServerName: "linear" });
    expect(session.warnings[1]).toMatchObject({ recoveryCommands: ["codex mcp login linear"] });
    expect(session.warnings[1]!.raw).toContain("MCP startup incomplete (failed: linear)");
    expect(activity).toContain("warning");
  });

  test("C-API-11 C-API-19 sends prompts and queued messages through bracketed paste", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const seen: string[] = [];
    const exits: number[] = [];
    const activity: string[] = [];
    ptys[0]!.emitData("early");
    await flushTerminal();
    session.on("terminal:data", (event) => seen.push(event.data));
    session.on("terminal:exit", (event) => exits.push(event.exitCode));
    session.on("activity", (event) => activity.push(event.kind));
    ptys[0]!.emitData("screen");
    await flushTerminal();
    await session.sendPrompt("hello\nworld");
    const queued = session.sendMessage("again");
    expect(ptys[0]!.writes).toEqual(["\u001b[200~hello\nworld\u001b[201~\r"]);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, stopEvent(cwd));
    await queued;
    await session.sendKeys(new Uint8Array([120]));
    await session.resize({ cols: 88, rows: 33 });
    ptys[0]!.emitExit({ exitCode: 7 });
    expect(ptys[0]!.writes).toEqual([
      "\u001b[200~hello\nworld\u001b[201~\r",
      "\u001b[200~again\u001b[201~\r",
      "x",
    ]);
    expect(ptys[0]!.size).toEqual({ cols: 88, rows: 33 });
    expect(seen).toEqual(["early", "screen"]);
    expect(exits).toEqual([7]);
    expect(activity).toContain("terminal_exit");
    expect(session.status).toBe("exited");
    await expect(session.sendKeys("after exit")).rejects.toMatchObject({
      code: "session_not_running",
    });
    await expect(session.resize({ cols: 80, rows: 24 })).rejects.toMatchObject({
      code: "session_not_running",
    });
  });

  test("C-HOOK-02 C-HOOK-05 Codex bridge errors and listener removal are observable", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const errors: string[] = [];
    const data: string[] = [];
    const handler = (event: { readonly data: string }) => data.push(event.data);
    session.on("hookError", (event) => errors.push(event.category));
    session.on("terminal:data", handler);
    session.off("terminal:data", handler);
    ptys[0]!.emitData("ignored");
    await ptys[0]!.dispatchMalformedHook(session.elwoodSessionId);
    expect(data).toEqual([]);
    expect(errors).toEqual(["invalid_input"]);
  });
  test("C-API-12 Codex transcript activity is emitted live", async () => {
    const cwd = tempDir();
    const transcript = join(cwd, "codex.jsonl");
    installFakes();
    writeFileSync(transcript, "");
    const session = await startCodex({ cwd });
    const seen: string[] = [];
    const activity: string[] = [];
    session.on("codex:transcript", (event) => seen.push(event.summary.kind));
    session.on("activity", (event) => activity.push(event.kind));
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "SessionStart",
      session_id: "codex-session-1",
      transcript_path: transcript,
      cwd,
      model: "gpt-5.3-codex",
      source: "startup",
    });
    appendFileSync(
      transcript,
      `${JSON.stringify({ type: "response_item", payload: { type: "reasoning" } })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen).toEqual(["reasoning"]);
    expect(activity).toContain("reasoning");
  });
});
const flushTerminal = () => new Promise((resolve) => setTimeout(resolve, 25));
const stopEvent = (cwd: string) => ({
  hook_event_name: "Stop",
  session_id: "codex-1",
  cwd,
  model: "gpt-5.3-codex",
  turn_id: "turn-1",
  stop_hook_active: false,
});
