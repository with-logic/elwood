/**
 * Bridge server fail-open coverage for throwing sinks and oversized requests.
 * Covers PRD §6.3 (fail-open guarantee and request byte cap).
 */

import { createConnection } from "node:net";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MAX_HOOK_REQUEST_BYTES } from "../../src/bridge/limits.ts";
import { HookBridgeServer } from "../../src/bridge/server.ts";
import { sendBridge, tempDirForUnit } from "./helpers.ts";

const acceptHookInput = () => true;
const input = JSON.stringify({ hook_event_name: "Stop", session_id: "s1", cwd: "/tmp" });

describe("bridge server fail-open limits", () => {
  test("C-HOOK-16 bridge still fails open when the error sink throws", async () => {
    const socketPath = join(tempDirForUnit(), "throwing-sink.sock");
    const server = new HookBridgeServer(
      socketPath,
      "token",
      () => Promise.reject(new Error("dispatch failed")),
      () => {
        throw new Error("observer exploded");
      },
      acceptHookInput,
    );
    await server.start();
    const response = await sendBridge(socketPath, JSON.stringify({ token: "token", input }));
    await server.stop();
    // A throwing hookError/activity observer must not wedge the socket: the
    // fail-open noDecision write still happens (PRD §6.3).
    expect(JSON.parse(response)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("C-HOOK-16 an oversized request fails open before dispatch or auth", async () => {
    const socketPath = join(tempDirForUnit(), "oversized.sock");
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
    // A framed request whose padded bytes push it past the cap.
    const oversized = `${"x".repeat(MAX_HOOK_REQUEST_BYTES + 16)}\n`;
    const response = await sendBridge(socketPath, oversized);
    await server.stop();
    expect(JSON.parse(response)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(dispatched).toBe(0);
    // Oversized IPC is treated as noise, not a hookError.
    expect(errors).toEqual([]);
  });

  test("C-HOOK-16 an unterminated oversized stream fails open without a frame", async () => {
    const socketPath = join(tempDirForUnit(), "oversized-unterminated.sock");
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
    );
    await server.start();
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    const ended = new Promise<void>((resolve) => socket.once("end", resolve));
    // Stream past the cap with no trailing newline: overflow alone fails open.
    socket.write("y".repeat(MAX_HOOK_REQUEST_BYTES + 32));
    await ended;
    await server.stop();
    expect(JSON.parse(response)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(dispatched).toBe(0);
  });
});
