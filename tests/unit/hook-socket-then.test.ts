/** Successful hook dispatch and socket serialization ignore inherited then (C-HOOK-21). */
import { join } from "node:path";
import { expect, test } from "vitest";
import { HookBridgeServer } from "../../src/bridge/server.ts";
import { requestHook } from "../../src/claude/hooks/dispatch.ts";
import { serializeHookResult } from "../../src/claude/serialize.ts";
import type { ClaudeEventMap } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { tempDir } from "../helpers/tmp.ts";
import { sendBridge } from "./helpers.ts";

test("C-HOOK-21 successful socket replies never assimilate inherited then", async () => {
  const socket = join(tempDir("elwood-prototype-"), "hook.sock");
  const emitter = new TypedEmitter<ClaudeEventMap>();
  const event = { hook_event_name: "Stop", session_id: "s1", cwd: "/tmp" } as const;
  let reads = 0;
  emitter.on("hook:Stop", () => {
    // biome-ignore lint/suspicious/noThenProperty: inherited then is the regression input.
    Object.defineProperty(Object.prototype, "then", {
      configurable: true,
      get() {
        // Exclude unrelated test-runner Promise resolutions during real socket I/O.
        if (Object.hasOwn(this, "exitCode")) reads += 1;
        return undefined;
      },
    });
    return { decision: "block", reason: "wait" };
  });
  const server = new HookBridgeServer(
    socket,
    "t",
    async () => {
      const outcome = await requestHook(emitter, event, 1000, "e1");
      return serializeHookResult("Stop", outcome.result);
    },
    () => {},
    () => true,
  );
  await server.start();
  let response: string;
  try {
    response = await sendBridge(socket, JSON.stringify({ token: "t", input: "{}" }));
  } finally {
    Reflect.deleteProperty(Object.prototype, "then");
    await server.stop();
  }
  expect(reads).toBe(0);
  expect(JSON.parse(response)).toEqual({
    exitCode: 0,
    stdout: '{"decision":"block","reason":"wait"}\n',
    stderr: "",
  });
});
