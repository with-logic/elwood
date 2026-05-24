/**
 * Conformance tests for Codex session startup and terminal controls.
 * Covers PRD §5.5, §5.7, §7A, and §9.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCodex } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("CodexSession startup and terminal control", () => {
  test("C-API-09 C-CODEX-02 starts Codex with generated hook config", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd, model: "gpt-5.3-codex", sandbox: "workspace-write" });
    const command = ptys[0]!.options.args.join(" ");
    expect(session.elwoodSessionId.length).toBeGreaterThan(0);
    expect(session.cwd).toBe(cwd);
    expect(session.status).toBe("running");
    expect(command).toContain("exec codex");
    expect(command).toContain("--cd");
    expect(command).toContain("--model");
    expect(command).toContain("--sandbox");
    expect(command).toContain("--dangerously-bypass-hook-trust");
    expect(command).toContain("hooks.Stop");
    expect(existsSync(join(cwd, ".elwood", ".gitignore"))).toBe(true);
  });

  test("C-CODEX-06 omits hook trust bypass when unsupported or opted out", async () => {
    const cwd = tempDir();
    installFakes({ supportsHookTrustBypass: false });
    await startCodex({ cwd });
    expect(ptys[0]!.options.args.join(" ")).not.toContain("--dangerously-bypass-hook-trust");
    resetFakes();
    const secondCwd = tempDir();
    installFakes();
    await startCodex({ cwd: secondCwd, bypassHookTrust: false });
    expect(ptys[0]!.options.args.join(" ")).not.toContain("--dangerously-bypass-hook-trust");
  });

  test("C-API-11 sends multiline prompts through bracketed paste", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const seen: string[] = [];
    const exits: number[] = [];
    const activity: string[] = [];
    session.on("terminal:data", (event) => seen.push(event.data));
    session.on("terminal:exit", (event) => exits.push(event.exitCode));
    session.on("activity", (event) => activity.push(event.kind));
    ptys[0]!.emitData("screen");
    await session.sendPrompt("hello\nworld");
    await session.sendMessage("again");
    await session.sendKeys(new Uint8Array([120]));
    await session.resize({ cols: 88, rows: 33 });
    ptys[0]!.emitExit({ exitCode: 7 });
    expect(ptys[0]!.writes).toEqual([
      "\u001b[200~hello\nworld\u001b[201~\r",
      "\u001b[200~again\u001b[201~\r",
      "x",
    ]);
    expect(ptys[0]!.size).toEqual({ cols: 88, rows: 33 });
    expect(seen).toEqual(["screen"]);
    expect(exits).toEqual([7]);
    expect(activity).toContain("terminal_exit");
    expect(session.status).toBe("exited");
  });

  test("C-HOOK Codex bridge errors and explicit listener removal are observable", async () => {
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

  test("C-HOOK Codex transcript activity is emitted live", async () => {
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
