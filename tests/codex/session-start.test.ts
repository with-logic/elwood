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

  test("C-ERR-07 non-strict unparseable version starts live-only, not persisted", async () => {
    const cwd = tempDir();
    installFakes();
    setCommandRunnerForTests((_command, args) =>
      args.join(" ").includes("--help")
        ? { status: 0, stdout: "--dangerously-bypass-hook-trust", stderr: "" }
        : { status: 0, stdout: "unknown build", stderr: "" },
    );
    // A non-strict unparseable version surfaces the warning LIVE on the first
    // caller-observable frame and still boots; §8 forbids persisting it.
    const session = await startCodex({ cwd });
    expect(session.status).toBe("running");
    const codes: string[] = [];
    session.on("warning", (event) => codes.push(event.code));
    ptys[0]!.emitData("ready frame"); // drive the first caller-observable frame
    await expect.poll(() => codes).toContain("version_unparseable");
    const dir = join(cwd, ".elwood", "sessions", session.elwoodSessionId);
    const persisted = readFileSync(join(dir, "session.json"), "utf8");
    expect(persisted).not.toContain("version_unparseable");
    expect(persisted).not.toContain("warning");
  });

  test("C-CODEX-12 skips Codex TUI update prompts", async () => {
    const cwd = tempDir();
    installFakes();
    await startCodex({ cwd });
    ptys[0]!.emitData("Update available\r\n  1. Update now\r\n  2. Continue without updating");
    await flushTerminal();
    expect(ptys[0]!.writes).toEqual(["2"]);
  });

  test("C-API-14 C-CODEX-09 emits each Codex MCP startup banner ONCE per occurrence", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const warningEvents: { code: string; [key: string]: unknown }[] = [];
    const activity: string[] = [];
    session.on("warning", (event) => warningEvents.push(event));
    session.on("activity", (event) => activity.push(event.kind));
    // First frame carries BOTH banners.
    ptys[0]!.emitData(
      "The linear MCP server is not logged in. Run `codex mcp login linear`.\nMCP startup incomplete (failed: linear)",
    );
    await flushTerminal();
    // An UNRELATED follow-up frame that does NOT re-show the banners must NOT re-emit
    // them: "once when observed" means a banner must clear and reappear to fire again,
    // not replay every later frame off the accumulated buffer (C-API-14, §5.7).
    ptys[0]!.emitData("just some ordinary output, no banners here");
    await flushTerminal();
    // EXACT cardinality: each banner fired exactly once across both frames.
    const codes = warningEvents.map((w) => w.code);
    expect(codes.filter((c) => c === "mcp_server_not_logged_in")).toHaveLength(1);
    expect(codes.filter((c) => c === "mcp_startup_incomplete")).toHaveLength(1);
    expect(warningEvents.find((w) => w.code === "mcp_server_not_logged_in")).toMatchObject({
      mcpServerName: "linear",
    });
    expect(warningEvents.find((w) => w.code === "mcp_startup_incomplete")).toMatchObject({
      recoveryCommands: ["codex mcp login linear"],
      raw: expect.stringContaining("MCP startup incomplete (failed: linear)"),
    });
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
    expect(ptys[0]!.writes).toEqual(["\u001b[200~hello\nworld\u001b[201~", "\r"]);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, stopEvent(cwd));
    await queued;
    await session.sendKeys(new Uint8Array([120]));
    await session.resize({ cols: 88, rows: 33 });
    ptys[0]!.emitExit({ exitCode: 7 });
    // Submitting Enters arrive as separate deferred keystrokes (C-API-31).
    expect(ptys[0]!.writes.filter((w) => w !== "\r")).toEqual([
      "\u001b[200~hello\nworld\u001b[201~",
      "\u001b[200~again\u001b[201~",
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
