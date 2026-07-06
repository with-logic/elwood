/**
 * Focused unit coverage for hook bridge error and filtering edges.
 * Covers PRD §6 and §10.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { HookBridgeServer } from "../../src/bridge/server.ts";
import { sendBridge, tempDirForUnit } from "./helpers.ts";

const acceptHookInput = () => true;
const rejectHookInput = () => false;

describe("bridge server edge handling", () => {
  test("C-HOOK-16 bridge fails open when dispatch throws", async () => {
    const socketPath = join(tempDirForUnit(), "throw-hook.sock");
    const errors: string[] = [];
    const server = new HookBridgeServer(
      socketPath,
      "token",
      () => Promise.reject(new Error("dispatch failed")),
      (event) => errors.push(`${event.category}:${event.message}`),
      acceptHookInput,
    );
    await server.start();
    const response = await sendBridge(socketPath, JSON.stringify({ token: "token", input }));
    await server.stop();
    expect(JSON.parse(response)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(errors).toEqual(["bridge_error:dispatch failed"]);
  });

  test("C-HOOK-16 bridge ignores mismatched sessions and malformed envelopes", async () => {
    const socketPath = join(tempDirForUnit(), "filtered-hook.sock");
    let dispatched = 0;
    const server = new HookBridgeServer(
      socketPath,
      "token",
      () => {
        dispatched += 1;
        return Promise.resolve({ exitCode: 1, stdout: "bad", stderr: "" });
      },
      () => {},
      acceptHookInput,
      "expected-elwood-session",
    );
    await server.start();
    const mismatch = await sendBridge(
      socketPath,
      JSON.stringify({ token: "token", elwoodSessionId: "other-session", input }),
    );
    const malformed = await sendBridge(socketPath, JSON.stringify({ token: "token" }));
    await server.stop();
    expect(JSON.parse(mismatch)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(JSON.parse(malformed)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(dispatched).toBe(0);
  });

  test("C-HOOK-16 invalid hook input reports identifiable hook names", async () => {
    const socketPath = join(tempDirForUnit(), "invalid-named-hook.sock");
    const errors: string[] = [];
    const server = new HookBridgeServer(
      socketPath,
      "token",
      async () => ({ exitCode: 0, stdout: "bad", stderr: "" }),
      (event) => errors.push(event.hookEventName),
      rejectHookInput,
    );
    await server.start();
    await sendBridge(
      socketPath,
      JSON.stringify({ token: "token", input: JSON.stringify({ hook_event_name: "Stop" }) }),
    );
    await server.stop();
    expect(errors).toEqual(["Stop"]);
  });

  test("C-HOOK-16 start replaces stale socket files left on disk", async () => {
    const socketPath = join(tempDirForUnit(), "stale-start.sock");
    writeFileSync(socketPath, "stale");
    let dispatched = 0;
    const server = new HookBridgeServer(
      socketPath,
      "token",
      () => {
        dispatched += 1;
        return Promise.resolve({ exitCode: 0, stdout: "ok", stderr: "" });
      },
      () => {},
      acceptHookInput,
    );
    await server.start();
    const response = await sendBridge(socketPath, JSON.stringify({ token: "token", input }));
    await server.stop();
    expect(JSON.parse(response)).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(dispatched).toBe(1);
  });

  test("C-HOOK-16 stop removes stale socket files after a failed start", async () => {
    const socketDir = join(tempDirForUnit(), "missing");
    const socketPath = join(socketDir, "stale-stop.sock");
    const server = new HookBridgeServer(
      socketPath,
      "token",
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      () => {},
      acceptHookInput,
    );
    await expect(server.start()).rejects.toThrow();
    mkdirSync(socketDir, { recursive: true });
    writeFileSync(socketPath, "stale");
    await server.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  test("C-HOOK-16 requests without a matching token are ignored", async () => {
    const socketPath = join(tempDirForUnit(), "auth-hook.sock");
    let dispatched = 0;
    const errors: string[] = [];
    const server = new HookBridgeServer(
      socketPath,
      "token",
      () => {
        dispatched += 1;
        return Promise.resolve({ exitCode: 1, stdout: "bad", stderr: "" });
      },
      (event) => errors.push(event.category),
      acceptHookInput,
    );
    await server.start();
    const missing = await sendBridge(socketPath, JSON.stringify({ input }));
    const mismatched = await sendBridge(socketPath, JSON.stringify({ token: "other", input }));
    await server.stop();
    expect(JSON.parse(missing)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(JSON.parse(mismatched)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(dispatched).toBe(0);
    expect(errors).toEqual([]);
  });

  test("C-HOOK-16 bridge fails open with a generic message for non-Error failures", async () => {
    const socketPath = join(tempDirForUnit(), "non-error-hook.sock");
    const errors: string[] = [];
    const server = new HookBridgeServer(
      socketPath,
      "token",
      () => Promise.reject({ message: "boom" }),
      (event) => errors.push(`${event.category}:${event.message}`),
      acceptHookInput,
    );
    await server.start();
    const response = await sendBridge(socketPath, JSON.stringify({ token: "token", input }));
    await server.stop();
    expect(JSON.parse(response)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(errors).toEqual(["bridge_error:Hook bridge failed"]);
  });
});

const input = JSON.stringify({ hook_event_name: "Stop", session_id: "s1", cwd: "/tmp" });
