/**
 * Conformance tests for Claude session startup and control.
 * Covers PRD §5, §6, §8, §9, and §10.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ElwoodError,
  resetClaudeSessionSeamsForTests,
  resetRuntimeSeamsForTests,
  resumeClaude,
  setCommandRunnerForTests,
  setHookBridgeFactoryForTests,
  setPlatformForTests,
  setPtyFactoryForTests,
  startClaude,
  type TerminalSize,
} from "../../src/index.ts";
import type { PtyExit, PtyProcess, PtySpawnOptions } from "../../src/pty/types.ts";

const ptys: FakePty[] = [];
const versionOk = () => ({ status: 0, stdout: "2.1.144\n", stderr: "" });

afterEach(() => {
  resetRuntimeSeamsForTests();
  resetClaudeSessionSeamsForTests();
  ptys.length = 0;
});

describe("ClaudeSession", () => {
  test("C-API-01 starts a Claude session with generated state and settings", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, disallowedTools: ["AskUserQuestion"] });
    expect(session.elwoodSessionId.length).toBeGreaterThan(0);
    expect(session.cwd).toBe(cwd);
    expect(session.status).toBe("running");
    expect(ptys[0]!.options.cwd).toBe(cwd);
    const sessionDir = join(cwd, ".elwood", "sessions", session.elwoodSessionId);
    expect(existsSync(join(cwd, ".elwood", ".gitignore"))).toBe(true);
    expect(readFileSync(join(sessionDir, "claude-settings.json"), "utf8")).toContain(
      "AskUserQuestion",
    );
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

  test("C-API-06 sends multiline prompts through bracketed paste", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await session.sendPrompt("hello\nworld");
    expect(ptys[0]!.writes).toEqual(["\u001b[200~hello\nworld\u001b[201~\r"]);
  });

  test("C-PTY-03 emits terminal data and supports raw keys and resize", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const seen: string[] = [];
    const unsubscribe = session.on("terminal:data", (event) => seen.push(event.data));
    session.off("terminal:data", () => {});
    ptys[0]!.emitData("abc");
    unsubscribe();
    ptys[0]!.emitData("ignored");
    await session.sendKeys("x");
    await session.resize({ cols: 80, rows: 24 });
    expect(seen).toEqual(["abc"]);
    expect(ptys[0]!.writes).toEqual(["x"]);
    expect(ptys[0]!.size).toEqual({ cols: 80, rows: 24 });
  });

  test("C-HOOK-03 fails open when no hook handler is registered", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-1",
      cwd,
      prompt: "hi",
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    const statuses: string[] = [];
    const offStatus = session.on("status", (event) => statuses.push(event.status));
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd,
    });
    expect(statuses).toEqual(["ready"]);
    expect(session.status).toBe("ready");
    offStatus();
  });

  test("C-HOOK-11 does not mark ready when Stop is blocked", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({
      cwd,
      hooks: { Stop: () => ({ decision: "block", reason: "tests are still failing" }) },
    });
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd,
    });
    expect(JSON.parse(result.stdout).decision).toBe("block");
    expect(session.status).toBe("running");
  });

  test("C-HRESP-01 serializes typed PreToolUse denial responses", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({
      cwd,
      hooks: {
        PreToolUse: () => ({
          permissionDecision: "deny",
          permissionDecisionReason: "No database writes",
        }),
      },
    });
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "PreToolUse",
      session_id: "claude-1",
      cwd,
      tool_name: "Bash",
      tool_input: { command: "psql" },
    });
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("C-HOOK-04 emits hookError and fails open on timeout", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({
      cwd,
      hookTimeoutMs: 1,
      hooks: { Stop: () => new Promise(() => {}) },
    });
    const errors: string[] = [];
    const offError = session.on("hookError", (event) => errors.push(event.category));
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(errors).toEqual(["timeout"]);
    offError();
  });

  test("C-HOOK-05 emits hookError and fails open on malformed hook input", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const errors: string[] = [];
    const offError = session.on("hookError", (event) => errors.push(event.category));
    const result = await ptys[0]!.dispatchMalformedHook(session.elwoodSessionId);
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(errors).toEqual(["invalid_input"]);
    offError();
  });

  test("C-HOOK-05 emits hookError and fails open on thrown handler errors", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({
      cwd,
      hooks: {
        UserPromptSubmit: () => {
          throw new Error("handler exploded");
        },
      },
    });
    const errors: string[] = [];
    session.on("hookError", (event) => errors.push(`${event.category}:${event.message}`));
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-1",
      cwd,
      prompt: "hello",
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(errors).toEqual(["handler_error:handler exploded"]);
  });

  test("C-HOOK-06 emits hookError and fails open on invalid handler results", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({
      cwd,
      hooks: { Notification: () => ({ decision: "block", reason: "invalid" }) as never },
    });
    const errors: string[] = [];
    session.on("hookError", (event) => errors.push(event.category));
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Notification",
      session_id: "claude-1",
      cwd,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(errors).toEqual(["invalid_response"]);
  });

  test("C-STATE-02 C-STATE-04 resumes from caller-provided Elwood metadata", async () => {
    const cwd = tempDir();
    const stateDir = join(tempDir(), "state");
    installFakes();
    const session = await startClaude({ cwd, stateDir, initialSize: { cols: 44, rows: 12 } });
    await session.stop();
    const resumed = await resumeClaude({ cwd, stateDir, elwoodSessionId: session.elwoodSessionId });
    expect(resumed.elwoodSessionId).toBe(session.elwoodSessionId);
    expect(ptys).toHaveLength(2);
    expect(ptys[1]!.size).toEqual({ cols: 44, rows: 12 });
  });

  test("C-STATE-05 C-STATE-06 keeps prompts, terminal data, and hook payloads live-only", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await session.sendPrompt("SECRET_PROMPT");
    ptys[0]!.emitData("SECRET_TERMINAL");
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-1",
      cwd,
      prompt: "SECRET_HOOK",
    });
    const dir = join(cwd, ".elwood", "sessions", session.elwoodSessionId);
    const persisted = readdirSync(dir)
      .filter((file) => file !== "hook.sock")
      .map((file) => readFileSync(join(dir, file), "utf8"))
      .join("\n");
    expect(persisted).not.toContain("SECRET_PROMPT");
    expect(persisted).not.toContain("SECRET_TERMINAL");
    expect(persisted).not.toContain("SECRET_HOOK");
  });

  test("C-LIFE-02 C-LIFE-03 C-STATE-07 C-STATE-08 lifecycle controls update and clean state", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const exits: number[] = [];
    const offExit = session.on("terminal:exit", (event) => exits.push(event.exitCode));
    const dir = join(cwd, ".elwood", "sessions", session.elwoodSessionId);
    await session.kill();
    expect(exits).toEqual([0]);
    offExit();
    expect(session.status).toBe("killed");
    expect(existsSync(join(dir, "session.json"))).toBe(true);
    await session.teardown();
    expect(session.status).toBe("torn_down");
    expect(existsSync(dir)).toBe(false);
  });

  test("C-PTY-06 process exit updates session status", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    ptys[0]!.emitExit({ exitCode: 7 });
    expect(session.status).toBe("exited");
  });

  test("C-ERR-02 unsupported platforms fail with typed error", async () => {
    installFakes();
    setPlatformForTests("linux");
    await expect(startClaude({ cwd: tempDir() })).rejects.toMatchObject({
      code: "unsupported_platform",
    });
  });

  test("C-ERR-01 missing Claude fails with typed error", async () => {
    installFakes();
    setCommandRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "",
      error: { code: "ENOENT", message: "missing" },
    }));
    await expect(startClaude({ cwd: tempDir() })).rejects.toBeInstanceOf(ElwoodError);
  });

  test("C-ERR-05 PTY startup failure is typed", async () => {
    installFakes();
    setPtyFactoryForTests(() => {
      throw new Error("pty failed");
    });
    await expect(startClaude({ cwd: tempDir() })).rejects.toMatchObject({
      code: "pty_start_failed",
    });
  });

  test("C-ERR-06 hook bridge startup failure is typed", async () => {
    installFakes();
    setHookBridgeFactoryForTests(() => ({
      start: () => Promise.reject(new Error("bridge failed")),
      stop: () => Promise.resolve(),
    }));
    await expect(startClaude({ cwd: tempDir() })).rejects.toMatchObject({
      code: "hook_bridge_failed",
    });
  });
});

function installFakes(): void {
  setPlatformForTests("darwin");
  setCommandRunnerForTests(versionOk);
  setPtyFactoryForTests((options) => {
    const pty = new FakePty(options);
    ptys.push(pty);
    return pty;
  });
}

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "elwood-"));
  mkdirSync(path, { recursive: true });
  return path;
}

class FakePty implements PtyProcess {
  readonly pid = ptys.length + 1;
  readonly writes: string[] = [];
  readonly dataHandlers: ((data: string) => void)[] = [];
  readonly exitHandlers: ((exit: PtyExit) => void)[] = [];
  readonly options: PtySpawnOptions;
  size: TerminalSize;

  constructor(options: PtySpawnOptions) {
    this.options = options;
    this.size = options.size;
  }

  onData(handler: (data: string) => void) {
    this.dataHandlers.push(handler);
    return () => {};
  }

  onExit(handler: (exit: PtyExit) => void) {
    this.exitHandlers.push(handler);
    return () => {};
  }

  write(data: string | Uint8Array): void {
    this.writes.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
  }

  resize(size: TerminalSize): void {
    this.size = size;
  }

  kill(): void {
    this.emitExit({ exitCode: 0 });
  }

  emitData(data: string): void {
    for (const handler of this.dataHandlers) handler(data);
  }

  emitExit(exit: PtyExit): void {
    for (const handler of this.exitHandlers) handler(exit);
  }

  async dispatchHook(elwoodSessionId: string, input: Record<string, unknown>) {
    const dir = join(this.options.cwd, ".elwood", "sessions", elwoodSessionId);
    const script = readFileSync(join(dir, "hook-bridge.mjs"), "utf8");
    const socketPath = /const socketPath = "([^"]+)"/.exec(script)![1]!;
    const token = /const token = "([^"]+)"/.exec(script)![1]!;
    return await this.dispatchRaw(
      socketPath,
      JSON.stringify({ token, input: JSON.stringify(input) }),
    );
  }

  async dispatchMalformedHook(elwoodSessionId: string) {
    const dir = join(this.options.cwd, ".elwood", "sessions", elwoodSessionId);
    const script = readFileSync(join(dir, "hook-bridge.mjs"), "utf8");
    const socketPath = /const socketPath = "([^"]+)"/.exec(script)![1]!;
    const token = /const token = "([^"]+)"/.exec(script)![1]!;
    return await this.dispatchRaw(socketPath, JSON.stringify({ token, input: "not-json" }));
  }

  private async dispatchRaw(socketPath: string, payload: string) {
    const net = await import("node:net");
    return await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      const client = net.createConnection({ path: socketPath });
      let response = "";
      client.on("data", (chunk) => {
        response += chunk.toString("utf8");
      });
      client.on("end", () => resolve(JSON.parse(response)));
      client.on("connect", () => {
        client.write(payload);
      });
    });
  }
}
