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
    // Framed data starts a gated dispatch. The following client FIN must not
    // close the response side before that handler supplies its decision.
    const socketPath = join(tempDir("elwood-unit-"), "half-open.sock");
    let dispatched = 0;
    const entered = Promise.withResolvers<void>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = new HookBridgeServer(
      socketPath,
      "token",
      async () => {
        dispatched += 1;
        entered.resolve();
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
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
    });
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    socket.end(`${JSON.stringify({ token: "token", input })}\n`); // framed data + FIN
    await entered.promise;
    release();
    await closed;
    await server.stop();
    // The guard dropped respond #2: exactly one dispatch, never a second.
    expect(dispatched).toBe(1);
    expect(JSON.parse(response)).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
  });
});
