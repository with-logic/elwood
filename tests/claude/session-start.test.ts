/**
 * Conformance tests for Claude session startup and PTY controls.
 * Covers PRD §5, §6, §8, §9, and §10.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { claudeBody, tty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSessionApi startup and terminal control", () => {
  test("C-API-01 C-CLAUDE-02 C-LIFE-01 C-LIFE-05 C-STATE-01 C-API-16 starts with generated state and default terminal size", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, disallowedTools: ["AskUserQuestion"] });
    expect(session.elwoodSessionId.length).toBeGreaterThan(0);
    expect(session.cwd).toBe(cwd);
    expect(session.status).toBe("running");
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

  test("C-STATE-04 persists only the minimal near-stateless record", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const record = JSON.parse(
      readFileSync(
        join(cwd, ".elwood", "sessions", session.elwoodSessionId, "session.json"),
        "utf8",
      ),
    );
    // The persisted record carries ONLY what resume needs; no metadata/name/status/
    // warnings/timestamps/paths/token/size round-trip through disk (near-stateless).
    expect(Object.keys(record).sort()).toEqual([
      "adapter",
      "claude",
      "codex",
      "cwd",
      "elwoodSessionId",
      "schemaVersion",
    ]);
    expect(record).toMatchObject({ schemaVersion: 1, adapter: "claude", cwd });
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

  test("C-ATTN-03 an auto-answered trust prompt does not block the session", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, autotrust: true });
    const attention: string[] = [];
    session.on("activity", (event) => {
      if (event.kind === "attention") attention.push(event.label);
    });
    ptys[0]!.emitData(
      `Quick safety check: Is this a project you created or one you trust?\r\n${tty(claudeBody)}\r\n1. Yes, I trust this folder\r\n`,
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
      `Quick safety check: Is this a project you created or one you trust?\r\n${tty(claudeBody)}\r\n1. Yes, I trust this folder\r\n`,
    );
    await expect.poll(() => session.status).toBe("blocked");
    expect(attention).toEqual(["claude-workspace_trust-prompt"]);
    // Elwood did not answer on the caller's behalf.
    expect(ptys[0]!.writes).toEqual([]);
  });

  test("C-ERR-07 a non-strict version-parse failure surfaces a live warning, not persisted", async () => {
    const cwd = tempDir();
    installFakes();
    setCommandRunnerForTests(() => ({ status: 0, stdout: "unknown build", stderr: "" }));
    // Non-strict startup proceeds despite an unparseable version. The version warning
    // is live-only: it surfaces on the first observable frame, never persisted.
    const session = await startClaude({ cwd });
    expect(session.status).toBe("running");
    const codes: string[] = [];
    session.on("warning", (event) => codes.push(event.code));
    ptys[0]!.emitData("❯ ready"); // drive the first caller-observable frame
    await expect.poll(() => codes).toContain("version_unparseable");
    const dir = join(cwd, ".elwood", "sessions", session.elwoodSessionId);
    const record = readFileSync(join(dir, "session.json"), "utf8");
    expect(record).not.toContain("version_unparseable");
    expect(record).not.toContain("warning");
  });

  test("C-API-05 C-API-06 C-API-07 C-API-13 C-API-19 sends prompts and queued messages", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await session.sendPrompt("hello\nworld");
    const queued = session.sendMessage("again");
    expect(ptys[0]!.writes).toEqual(["\u001b[200~hello\nworld\u001b[201~", "\r"]);
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
    ptys[0]!.emitData("early");
    await session.terminal.settled();
    const unsubscribe = session.on("terminal:data", (event) => seen.push(event.data));
    session.on("activity", (event) => activity.push(event.kind));
    // off() removes a REGISTERED handler: it sees the registration-time replay of
    // buffered startup data ("early") and nothing emitted after removal.
    const removed: string[] = [];
    const removable = (event: { readonly data: string }) => removed.push(event.data);
    session.on("terminal:data", removable);
    session.off("terminal:data", removable);
    ptys[0]!.emitData("abc");
    await session.terminal.settled();
    expect(removed).toEqual(["early"]);
    unsubscribe();
    ptys[0]!.emitData("ignored");
    await session.sendKeys("x");
    await session.resize({ cols: 80, rows: 24 });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "claude-1",
      cwd,
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
    ptys[0]!.emitExit({ exitCode: 7 });
    expect(seen).toEqual(["early", "abc"]);
    expect(ptys[0]!.writes).toEqual(["x"]);
    expect(ptys[0]!.size).toEqual({ cols: 80, rows: 24 });
    expect(activity).toContain("terminal_exit");
  });
});
