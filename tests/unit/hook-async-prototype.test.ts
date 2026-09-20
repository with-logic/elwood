/** Async dispatch and socket replies ignore inherited executable properties (C-HOOK-21). */
import { join } from "node:path";
import { expect, test } from "vitest";
import { HookBridgeServer } from "../../src/bridge/server.ts";
import { requestHook } from "../../src/claude/hooks/dispatch.ts";
import type { HookDispatchOutcome } from "../../src/core/hook-dispatch.ts";
import type { ClaudeEventMap } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { tempDir } from "../helpers/tmp.ts";
import { sendBridge } from "./helpers.ts";

for (const mode of ["response", "absent", "invalid", "timeout"] as const) {
  test(`C-HOOK-21 ${mode} async wrappers never read inherited then`, async () => {
    const emitter = new TypedEmitter<ClaudeEventMap>();
    if (mode === "response") emitter.on("hook:Stop", () => ({ decision: "block", reason: "wait" }));
    if (mode === "invalid") emitter.on("hook:Stop", () => 42);
    if (mode === "timeout") emitter.on("hook:Stop", () => new Promise(() => {}));
    const event = { hook_event_name: "Stop", session_id: "s1", cwd: "/tmp" } as const;
    let reads = 0;
    // biome-ignore lint/suspicious/noThenProperty: inherited then is the regression input.
    Object.defineProperty(Object.prototype, "then", {
      configurable: true,
      get() {
        // Vitest also resolves an unrelated array while a real timeout is pending.
        if (!Array.isArray(this)) reads += 1;
        return undefined;
      },
    });
    let outcome: HookDispatchOutcome<unknown>;
    try {
      outcome = await requestHook(emitter, event, 5, "e1");
    } finally {
      Reflect.deleteProperty(Object.prototype, "then");
    }
    expect(reads).toBe(0);
    expect(outcome.failedOpen).toBe(mode === "invalid" || mode === "timeout");
    if (mode === "response") expect(outcome.result).toEqual({ decision: "block", reason: "wait" });
  });
}

test("C-HOOK-21 outer socket response cannot inherit a serializer after dispatch", async () => {
  const socket = join(tempDir("elwood-prototype-"), "hook.sock");
  const payload = JSON.stringify({ token: "t", input: "{}" });
  let calls = 0;
  const server = new HookBridgeServer(
    socket,
    "t",
    () => {
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        get() {
          calls += 1;
          return () => "replaced";
        },
      });
      return Promise.resolve({ exitCode: 0, stdout: "validated decision", stderr: "" });
    },
    () => {},
    () => true,
  );
  await server.start();
  let response: string;
  try {
    response = await sendBridge(socket, payload);
  } finally {
    Reflect.deleteProperty(Object.prototype, "toJSON");
    await server.stop();
  }
  expect(calls).toBe(0);
  expect(JSON.parse(response)).toEqual({ exitCode: 0, stdout: "validated decision", stderr: "" });
});

test.each([
  "malformed",
  "unauthenticated",
] as const)("C-HOOK-21 %s socket fail-open never reads inherited then", async (mode) => {
  const socket = join(tempDir("elwood-prototype-"), "hook.sock");
  const server = new HookBridgeServer(
    socket,
    "t",
    () => {
      throw new Error("must not dispatch");
    },
    () => {},
    () => true,
  );
  await server.start();
  let reads = 0;
  // biome-ignore lint/suspicious/noThenProperty: inherited then is the regression input.
  Object.defineProperty(Object.prototype, "then", {
    configurable: true,
    get() {
      // Vitest also resolves unrelated objects while socket I/O is pending.
      if (Object.hasOwn(this, "exitCode")) reads += 1;
      return undefined;
    },
  });
  let response: string;
  try {
    response = await sendBridge(
      socket,
      mode === "malformed" ? "{" : JSON.stringify({ token: "wrong", input: "{}" }),
    );
  } finally {
    Reflect.deleteProperty(Object.prototype, "then");
    await server.stop();
  }
  expect(reads).toBe(0);
  expect(JSON.parse(response)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
});
