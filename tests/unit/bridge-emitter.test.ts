/**
 * Focused unit coverage for bridge validation and typed event emission.
 * Covers PRD §6, §8, and §10.
 */

import { createConnection } from "node:net";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { HookBridgeServer } from "../../src/bridge/server.ts";
import { sendBridge, tempDirForUnit } from "./helpers.ts";

const acceptHookInput = () => true;
const rejectHookInput = () => false;

describe("bridge and emitter edges", () => {
  test("C-HOOK-16 invalid bridge input fails open and reports an error", async () => {
    const root = tempDirForUnit();
    const socketPath = join(root, "hook.sock");
    const errors: string[] = [];
    const server = new HookBridgeServer(
      socketPath,
      "token",
      async () => ({ exitCode: 0, stdout: "unused", stderr: "" }),
      (event) => errors.push(event.category),
      rejectHookInput,
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
    expect(errors).toEqual(["invalid_input", "invalid_input"]);
  });

  test("C-ERR-06 bridge start rejects when its socket cannot be created", async () => {
    const server = new HookBridgeServer(
      join(tempDirForUnit(), "missing", "hook.sock"),
      "token",
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      () => {},
      acceptHookInput,
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
      acceptHookInput,
    );
    await server.start();
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await server.stop();
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  test("bridge ignores hook client disconnects before response", async () => {
    const socketPath = join(tempDirForUnit(), "disconnect-hook.sock");
    let release!: () => void;
    const delay = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = new HookBridgeServer(
      socketPath,
      "token",
      async () => {
        await delay;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      () => {},
      acceptHookInput,
    );
    await server.start();
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      `${JSON.stringify({
        token: "token",
        input: JSON.stringify({ hook_event_name: "Stop", session_id: "s1", cwd: "/tmp" }),
      })}\n`,
    );
    socket.destroy();
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const response = await sendBridge(
      socketPath,
      JSON.stringify({
        token: "token",
        input: JSON.stringify({ hook_event_name: "Stop", session_id: "s2", cwd: "/tmp" }),
      }),
    );
    await server.stop();
    expect(JSON.parse(response)).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
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
      acceptHookInput,
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
});
