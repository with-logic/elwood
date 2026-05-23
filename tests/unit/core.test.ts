/**
 * Focused unit coverage for core helpers backing PRD conformance.
 * Covers PRD §4, §6, §8, §9, and §10.
 */

import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookBridgeServer } from "../../src/bridge/server.ts";
import { isClaudeHookResult } from "../../src/bridge/validate.ts";
import { buildClaudeShellCommand, shellLaunch } from "../../src/claude/command.ts";
import { minimumClaudeVersion, parseVersion, preflightClaude } from "../../src/claude/preflight.ts";
import { serializeHookResult } from "../../src/claude/serialize.ts";
import { generateClaudeSettings } from "../../src/claude/settings.ts";
import { ElwoodError } from "../../src/core/errors.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import {
  currentCommandRunner,
  currentPlatform,
  currentPtyFactory,
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
} from "../../src/runtime/seams.ts";
import { defaultStateDir, readSessionRecord, sessionDir } from "../../src/state/store.ts";

describe("serialization", () => {
  test("C-HRESP variants serialize to Claude-compatible output", () => {
    expect(serializeHookResult("PermissionRequest", { behavior: "allow" }).stdout).toContain(
      "decision",
    );
    expect(serializeHookResult("PermissionDenied", { retry: true }).stdout).toContain("retry");
    expect(serializeHookResult("Elicitation", { action: "decline" }).stdout).toContain("decline");
    expect(
      serializeHookResult("Stop", { decision: "block", reason: "keep going" }).stdout,
    ).toContain("keep going");
    expect(
      serializeHookResult("Stop", {
        decision: "block",
        reason: "keep going",
        additionalContext: "tests failed",
      }).stdout,
    ).toContain("tests failed");
    expect(
      serializeHookResult("SessionStart", { additionalContext: "branch main" }).stdout,
    ).toContain("branch main");
    expect(serializeHookResult("WorktreeCreate", { worktreePath: "/tmp/w" }).stdout).toBe(
      "/tmp/w\n",
    );
    expect(serializeHookResult("WorktreeRemove", { worktreePath: "/tmp/w" }).stdout).toContain(
      "worktreePath",
    );
  });
});

describe("preflight", () => {
  test("C-CLAUDE version parsing and comparisons cover strict paths", () => {
    expect(parseVersion("claude 2.1.144")).toBe(minimumClaudeVersion);
    setPlatformForTests("darwin");
    setCommandRunnerForTests(() => ({ status: 1, stdout: "", stderr: "boom" }));
    expect(() => preflightClaude(false)).toThrow(ElwoodError);
    setCommandRunnerForTests(() => ({ status: 0, stdout: "unparseable", stderr: "" }));
    expect(() => preflightClaude(false)).not.toThrow();
    expect(() => preflightClaude(true)).toThrow(ElwoodError);
    setCommandRunnerForTests(() => ({ status: 0, stdout: "2.1.1", stderr: "" }));
    expect(() => preflightClaude(false)).toThrow(ElwoodError);
    resetRuntimeSeamsForTests();
  });

  test("runtime seams expose real defaults", () => {
    expect(typeof currentPlatform()).toBe("string");
    expect(currentCommandRunner()("bun", ["--version"]).stdout.length).toBeGreaterThan(0);
  });
});

describe("settings and command construction", () => {
  test("C-CLAUDE launch policy is reflected in generated command/settings", () => {
    const command = buildClaudeShellCommand("/tmp/settings.json", {
      cwd: "/tmp/project",
      permissionMode: "plan",
      allowedTools: ["Bash", "Read"],
      name: "demo",
    });
    expect(command).toContain("--permission-mode");
    expect(command).toContain("--tools");
    expect(command).toContain("--name");
    expect(shellLaunch("/bin/zsh", command).args).toContain("-c");
    const settings = generateClaudeSettings({
      bridgeScriptPath: "/tmp/bridge.mjs",
      timeoutSeconds: 3,
      options: {
        disallowedTools: ["AskUserQuestion"],
        settingsOverrides: { permissions: { allow: ["Read"] } },
      },
    });
    expect(JSON.stringify(settings)).toContain("AskUserQuestion");
  });
});

describe("state store", () => {
  test("C-STATE error paths are typed", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-state-"));
    expect(defaultStateDir(root)).toBe(join(root, ".elwood"));
    expect(sessionDir(root, "missing")).toBe(join(root, "sessions", "missing"));
    expect(() => readSessionRecord(root, "missing")).toThrow(ElwoodError);
    const dir = sessionDir(root, "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.json"), '{"schemaVersion":2,"elwoodSessionId":"bad"}');
    expect(() => readSessionRecord(root, "bad")).toThrow(ElwoodError);
  });
});

describe("bridge and emitter edges", () => {
  test("C-HOOK invalid bridge input fails open and reports an error", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-bridge-"));
    const socketPath = join(root, "hook.sock");
    const errors: string[] = [];
    const server = new HookBridgeServer(
      socketPath,
      "token",
      async () => ({ exitCode: 0, stdout: "unused", stderr: "" }),
      (event) => errors.push(event.category),
    );
    await server.start();
    const response = await sendBridge(socketPath, "not-json");
    const invalidHook = await sendBridge(
      socketPath,
      JSON.stringify({ token: "token", input: "not-json" }),
    );
    await server.stop();
    await server.stop();
    expect(JSON.parse(response)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(JSON.parse(invalidHook)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(errors).toEqual(["invalid_input"]);
  });

  test("C-ERR-06 bridge start rejects when its socket cannot be created", async () => {
    const server = new HookBridgeServer(
      join(tempDirForUnit(), "missing", "hook.sock"),
      "token",
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      () => {},
    );
    await expect(server.start()).rejects.toBeInstanceOf(Error);
    await server.stop();
  });

  test("C-HOOK-06 validates hook results by event semantics", () => {
    expect(isClaudeHookResult("PreToolUse", null)).toBe(false);
    expect(isClaudeHookResult("PreToolUse", { permissionDecision: "allow" })).toBe(true);
    expect(isClaudeHookResult("Stop", { permissionDecision: "allow" })).toBe(false);
    expect(isClaudeHookResult("PermissionRequest", { behavior: "deny" })).toBe(true);
    expect(isClaudeHookResult("Stop", { behavior: "deny" })).toBe(false);
    expect(isClaudeHookResult("PermissionDenied", { retry: true })).toBe(true);
    expect(isClaudeHookResult("PermissionDenied", { retry: false })).toBe(false);
    expect(isClaudeHookResult("WorktreeCreate", { worktreePath: "/tmp/w" })).toBe(true);
    expect(isClaudeHookResult("Stop", { worktreePath: "/tmp/w" })).toBe(false);
    expect(isClaudeHookResult("Elicitation", { action: "accept" })).toBe(true);
    expect(isClaudeHookResult("Stop", { action: "accept" })).toBe(false);
    expect(isClaudeHookResult("SubagentStop", { decision: "block", reason: "wait" })).toBe(true);
    expect(isClaudeHookResult("Stop", { decision: "block" })).toBe(false);
    expect(isClaudeHookResult("Notification", { additionalContext: "nope" })).toBe(false);
    expect(isClaudeHookResult("SessionStart", { additionalContext: "ctx" })).toBe(true);
    expect(isClaudeHookResult("SessionStart", {})).toBe(false);
    expect(isClaudeHookResult("SessionStart", { other: true })).toBe(false);
    expect(isClaudeHookResult("SessionStart", { watchPaths: [".env"] })).toBe(true);
    expect(isClaudeHookResult("SessionStart", { watchPaths: [1] })).toBe(false);
  });

  test("event emitter handles empty emissions and explicit off", async () => {
    const emitter = new TypedEmitter();
    emitter.emit("status", { elwoodSessionId: "x", status: "running" });
    expect(
      await emitter.request("status", { elwoodSessionId: "x", status: "running" }),
    ).toBeUndefined();
    const statuses: string[] = [];
    const handler = (event: { readonly status: string }) => statuses.push(event.status);
    const unsubscribe = emitter.on("status", handler);
    emitter.emit("status", { elwoodSessionId: "x", status: "running" });
    emitter.off("status", handler);
    unsubscribe();
    emitter.emit("status", { elwoodSessionId: "x", status: "ready" });
    const offUndefinedHandler = emitter.on("status", () => undefined);
    expect(
      await emitter.request("status", { elwoodSessionId: "x", status: "ready" }),
    ).toBeUndefined();
    offUndefinedHandler();
    emitter.listen("status", (event) => event.status);
    expect(await emitter.request("status", { elwoodSessionId: "x", status: "ready" })).toBe(
      "ready",
    );
    expect(statuses).toEqual(["running"]);
  });
});

function tempDirForUnit(): string {
  return mkdtempSync(join(tmpdir(), "elwood-unit-"));
}

async function sendBridge(socketPath: string, payload: string): Promise<string> {
  const net = await import("node:net");
  return await new Promise<string>((resolve) => {
    const client = net.createConnection({ path: socketPath });
    let data = "";
    client.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    client.on("end", () => resolve(data));
    client.on("connect", () => client.write(payload));
  });
}

describe("node PTY adapter", () => {
  test("C-PTY-01 wraps a real pseudoterminal process", async () => {
    const calls: string[] = [];
    mock.module("node-pty", () => ({
      spawn: () => ({
        pid: 42,
        onData: (handler: (data: string) => void) => {
          handler("hello");
          return { dispose: () => calls.push("off-data") };
        },
        onExit: (handler: (event: { exitCode: number }) => void) => {
          handler({ exitCode: 0 });
          return { dispose: () => calls.push("off-exit") };
        },
        write: (data: string) => calls.push(`write:${data}`),
        resize: (cols: number, rows: number) => calls.push(`resize:${cols}x${rows}`),
        kill: (signal?: string) => calls.push(`kill:${signal}`),
      }),
    }));
    const { nodePtyFactory } = await import("../../src/pty/node.ts");
    const pty = nodePtyFactory({
      command: "fake",
      args: [],
      cwd: process.cwd(),
      env: process.env,
      size: { cols: 20, rows: 5 },
    });
    let data = "";
    const offData = pty.onData((chunk) => {
      data = chunk;
    });
    let exitCode = -1;
    const offExit = pty.onExit((event) => {
      exitCode = event.exitCode;
    });
    pty.resize({ cols: 30, rows: 10 });
    pty.write("hello\n");
    pty.write(new Uint8Array([113, 10]));
    pty.kill();
    offData();
    offExit();
    expect(pty.pid).toBe(42);
    expect(data).toBe("hello");
    expect(exitCode).toBe(0);
    expect(calls).toContain("resize:30x10");
    expect(calls).toContain("write:hello\n");
    expect(calls).toContain("write:q\n");
    expect(calls).toContain("kill:SIGTERM");
    expect(calls).toContain("off-data");
    expect(calls).toContain("off-exit");
    resetRuntimeSeamsForTests();
    const runtimePty = currentPtyFactory()({
      command: "fake",
      args: [],
      cwd: process.cwd(),
      env: process.env,
      size: { cols: 10, rows: 3 },
    });
    const offRuntimeData = runtimePty.onData(() => {});
    const offRuntimeExit = runtimePty.onExit(() => {});
    runtimePty.write("x");
    runtimePty.resize({ cols: 11, rows: 4 });
    runtimePty.kill("SIGKILL");
    offRuntimeData();
    offRuntimeExit();
    expect(runtimePty.pid).toBe(42);
  });
});
