/**
 * Bridge server fail-open coverage for throwing sinks and oversized requests.
 * Covers PRD §6.3 (fail-open guarantee and request byte cap).
 */

import { createConnection } from "node:net";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MAX_HOOK_REQUEST_BYTES } from "../../src/bridge/limits.ts";
import { HookBridgeServer } from "../../src/bridge/server.ts";
import { tempDir } from "../helpers/tmp.ts";
import { sendBridge, sendRaw } from "./helpers.ts";

const acceptHookInput = () => true;
const input = JSON.stringify({ hook_event_name: "Stop", session_id: "s1", cwd: "/tmp" });

describe("bridge server fail-open limits", () => {
  test("C-HOOK-16 bridge still fails open when the error sink throws", async () => {
    const socketPath = join(tempDir("elwood-unit-"), "throwing-sink.sock");
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
    const socketPath = join(tempDir("elwood-unit-"), "oversized.sock");
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

  test("C-HOOK-16 exactly at the cap is accepted; one byte over fails open", async () => {
    // Pins the exact 8,388,608-byte boundary: a `>` → `>=` regression would flip
    // acceptance of the at-cap request and stay green without this. Sent as raw bytes
    // with a client that tolerates the server's mid-write destroy on the over-cap case.
    const socketPath = join(tempDir("elwood-unit-"), "boundary.sock");
    let dispatched = 0;
    const server = new HookBridgeServer(
      socketPath,
      "token",
      () => {
        dispatched += 1;
        return Promise.resolve({ exitCode: 7, stdout: "ok", stderr: "" });
      },
      () => {},
      acceptHookInput,
    );
    await server.start();
    // A valid framed envelope whose `input` is real hook JSON with a padded field, so
    // it PARSES and dispatches; pad so the whole request is EXACTLY MAX bytes (the
    // framing newline is counted). "z" needs no JSON escaping.
    const build = (padLen: number) => {
      const input = JSON.stringify({ hook_event_name: "Stop", pad: "z".repeat(padLen) });
      return `${JSON.stringify({ token: "token", input })}\n`;
    };
    const overhead = Buffer.byteLength(build(0), "utf8");
    const atCap = build(MAX_HOOK_REQUEST_BYTES - overhead);
    expect(Buffer.byteLength(atCap, "utf8")).toBe(MAX_HOOK_REQUEST_BYTES);
    expect(JSON.parse(await sendRaw(socketPath, atCap))).toMatchObject({ exitCode: 7 });
    expect(dispatched).toBe(1); // at-cap dispatched (not failed open)
    const over = `${atCap.slice(0, -1)}z\n`;
    expect(Buffer.byteLength(over, "utf8")).toBe(MAX_HOOK_REQUEST_BYTES + 1);
    expect(JSON.parse(await sendRaw(socketPath, over))).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    await server.stop();
    expect(dispatched).toBe(1); // still 1: the over-cap request did NOT dispatch
  });

  test("C-HOOK-16 a multibyte code point split across chunks is not corrupted", async () => {
    // The 4-byte 😀 is split across two writes. Decoding each chunk on its own would
    // insert replacement chars; the server must accumulate bytes and decode once, so
    // the dispatched hook input carries the intact emoji, not `a���b`.
    const socketPath = join(tempDir("elwood-unit-"), "split-utf8.sock");
    let resolveInput!: (v: unknown) => void;
    const gotInput = new Promise<unknown>((resolve) => {
      resolveInput = resolve;
    });
    const server = new HookBridgeServer(
      socketPath,
      "token",
      (parsed) => {
        resolveInput(parsed);
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
      () => {},
      acceptHookInput,
    );
    await server.start();
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.on("data", () => {}); // drain the response so the socket can close cleanly
    // input carries the emoji; the framed request is a JSON envelope with a hook input.
    const request = Buffer.from(
      `${JSON.stringify({ token: "token", input: JSON.stringify({ hook_event_name: "Stop", marker: "a😀b" }) })}\n`,
      "utf8",
    );
    const emojiStart = request.indexOf(Buffer.from("😀", "utf8"));
    // Write up to the middle of the emoji's bytes, then the rest — straddling chunks.
    socket.write(request.subarray(0, emojiStart + 2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    socket.write(request.subarray(emojiStart + 2));
    const received = await gotInput;
    await server.stop();
    expect((received as { marker?: string })?.marker).toBe("a😀b");
  });

  test("C-HOOK-16 an unterminated oversized stream fails open without a frame", async () => {
    const socketPath = join(tempDir("elwood-unit-"), "oversized-unterminated.sock");
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
