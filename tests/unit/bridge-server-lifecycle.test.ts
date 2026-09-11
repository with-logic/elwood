/**
 * Bridge server socket-lifecycle coverage: a responded socket is released (no
 * half-open FD leak) and a re-entrant respond is dropped by the `responded` guard.
 * Covers PRD §6.2/§6.3. The byte-cap fail-open cases live in a sibling file.
 */

import { createConnection } from "node:net";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { HookBridgeServer } from "../../src/bridge/server.ts";
import { tempDir } from "../helpers/tmp.ts";

const acceptHookInput = () => true;
const input = JSON.stringify({ hook_event_name: "Stop", session_id: "s1", cwd: "/tmp" });

describe("bridge server socket lifecycle", () => {
  test("C-HOOK-16 a responded socket is released and a re-entrant respond is dropped", async () => {
    // A half-open client must not keep the server-side socket (and its FD / input
    // budget) alive after it has its answer, and a second respond must be dropped so
    // one request never dispatches twice. `end(payload)` sends the framed request AND
    // the client FIN together: the server's framed-`data` respond parks in dispatch
    // while the client-FIN `end` fires respond a SECOND time, which the `responded`
    // guard must drop. Dispatch is gated open so the FIN lands mid-await. Once
    // released, the single response flushes and the socket is destroyed (client
    // `close`), all without server.stop().
    const socketPath = join(tempDir("elwood-unit-"), "half-open.sock");
    let dispatched = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = new HookBridgeServer(
      socketPath,
      "token",
      async () => {
        dispatched += 1;
        await gate;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      () => {},
      acceptHookInput,
    );
    await server.start();
    const socket = createConnection({ path: socketPath, allowHalfOpen: true });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    socket.end(`${JSON.stringify({ token: "token", input })}\n`); // framed data + FIN
    await new Promise((resolve) => setTimeout(resolve, 20)); // let data + end both fire
    release(); // dispatch resolves; the single response flushes and the socket is destroyed
    await closed;
    await server.stop();
    // The guard dropped respond #2: exactly one dispatch, never a second.
    expect(dispatched).toBe(1);
  });
});
