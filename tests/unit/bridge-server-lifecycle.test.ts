/**
 * Bridge server socket-lifecycle coverage: framed data and client FIN cannot
 * dispatch the same request twice while its first handler is pending.
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
  test("C-HOOK-16 framed data and FIN dispatch a pending request only once", async ({
    onTestFinished,
  }) => {
    // Framed data starts a gated dispatch; the following client FIN must invoke
    // respond again while that dispatch is still pending. The server's default
    // half-close behavior returns a FIN, which is observable proof its end event
    // ran. Waiting for that event avoids assuming the OS delivers FIN within 20ms.
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
    onTestFinished(() => server.stop());
    await server.start();
    const socket = createConnection({ path: socketPath, allowHalfOpen: true });
    onTestFinished(() => {
      release();
      socket.destroy();
    });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    // Consume the reply so Node can observe the remote FIN and emit close.
    socket.resume();
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    const ended = new Promise<void>((resolve) => socket.once("end", resolve));
    socket.end(`${JSON.stringify({ token: "token", input })}\n`); // framed data + FIN
    await ended; // The server FIN proves it handled our FIN while dispatch is gated.
    release(); // Complete the pending handler after observing both request boundaries.
    await closed;
    await server.stop();
    // The guard dropped respond #2: exactly one dispatch, never a second.
    expect(dispatched).toBe(1);
  });
});
