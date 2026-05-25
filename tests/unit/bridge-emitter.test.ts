/**
 * Focused unit coverage for bridge validation and typed event emission.
 * Covers PRD §6, §8, and §10.
 */

import { describe, expect, test } from "bun:test";
import { createConnection } from "node:net";
import { join } from "node:path";
import { HookBridgeServer } from "../../src/bridge/server.ts";
import { isClaudeHookResult } from "../../src/bridge/validate.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { sendBridge, tempDirForUnit } from "./helpers.ts";

describe("bridge and emitter edges", () => {
  test("C-HOOK invalid bridge input fails open and reports an error", async () => {
    const root = tempDirForUnit();
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

  test("bridge stop destroys open hook sockets", async () => {
    const root = tempDirForUnit();
    const socketPath = join(root, "open-hook.sock");
    const server = new HookBridgeServer(
      socketPath,
      "token",
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      () => {},
    );
    await server.start();
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await server.stop();
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  test("C-HOOK-16 bridge waits for a complete framed request", async () => {
    const root = tempDirForUnit();
    const socketPath = join(root, "split-hook.sock");
    let dispatched = 0;
    const server = new HookBridgeServer(
      socketPath,
      "token",
      async () => {
        await Promise.resolve();
        dispatched += 1;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      () => {},
    );
    await server.start();
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    let response = "";
    const ended = new Promise<void>((resolve) => socket.once("end", resolve));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    const input = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd: "/tmp/project",
    });
    const payload = JSON.stringify({ token: "token", input });
    socket.write(payload.slice(0, 10));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatched).toBe(0);
    socket.write(`${payload.slice(10)}\n`);
    await ended;
    await server.stop();
    expect(dispatched).toBe(1);
    expect(JSON.parse(response)).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
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
    expect(isClaudeHookResult("SessionEnd", { additionalContext: "too late" })).toBe(false);
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
