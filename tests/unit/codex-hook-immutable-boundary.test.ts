/** Codex hook observation cannot rewrite policy input or wire decisions (PRD §7A.2, C-HOOK-23). */
import { afterEach, expect, test } from "vitest";
import { dispatchHook } from "../../src/codex/session/hooks.ts";
import type { CodexEventMap } from "../../src/codex/session/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { startCodex } from "../../src/index.ts";
import { createSessionRecord } from "../../src/state/store.ts";
import { installFakes, ptys, resetFakes, tempDir } from "../codex/helpers.ts";

afterEach(resetFakes);

const record = createSessionRecord({ id: "codex-immutable", cwd: "/tmp", adapter: "codex" });

const tool = {
  hook_event_name: "PreToolUse",
  session_id: "codex-1",
  cwd: "/tmp",
  turn_id: "turn-1",
  tool_name: "Bash",
  tool_input: { command: "echo original" },
} as const;

const stop = {
  hook_event_name: "Stop",
  session_id: "codex-1",
  cwd: "/tmp",
  turn_id: "turn-1",
  stop_hook_active: false,
} as const;

test("C-HOOK-23 Codex observer cannot rewrite nested tool input before policy routing", async () => {
  const emitter = new TypedEmitter<CodexEventMap>();
  let command: string | undefined;
  emitter.on("hook", (event) => {
    Reflect.set(event, "hook_event_name", "Stop");
    if ("tool_input" in event) Reflect.set(event.tool_input, "command", "echo altered");
  });
  emitter.on("hook:PreToolUse", (event) => {
    if (
      "tool_input" in event &&
      "command" in event.tool_input &&
      typeof event.tool_input.command === "string"
    )
      command = event.tool_input.command;
    return { permissionDecision: "deny", permissionDecisionReason: "blocked" };
  });
  const result = await dispatchHook(structuredClone(tool), emitter, { cwd: "/tmp" }, record);
  expect(command).toBe("echo original");
  expect(result.stdout).toContain('"permissionDecision":"deny"');
});

test("C-HOOK-22 C-HOOK-23 a frozen-event mutation throw cannot abort Codex policy routing", async () => {
  const emitter = new TypedEmitter<CodexEventMap>();
  const warnings: string[] = [];
  emitter.on("hook", (event) => {
    (event as { hook_event_name: string }).hook_event_name = "Stop";
  });
  emitter.on("hook:PreToolUse", () => ({
    permissionDecision: "deny",
    permissionDecisionReason: "blocked",
  }));
  emitter.on("warning", (event) =>
    warnings.push(`${event.code}:${"phase" in event ? event.phase : ""}`),
  );
  const result = await dispatchHook(structuredClone(tool), emitter, { cwd: "/tmp" }, record);
  expect(result.stdout).toContain('"permissionDecision":"deny"');
  expect(warnings).toEqual(["hook_observer_failed:hook"]);
});

test("C-HOOK-23 Codex result activity cannot rewrite validated wire decision", async () => {
  const emitter = new TypedEmitter<CodexEventMap>();
  emitter.on("hook:Stop", () => ({ decision: "block", reason: "stay" }));
  emitter.on("activity", (event) => {
    if (event.kind !== "hook_result") return;
    const raw = event.raw as { result: object };
    Reflect.set(raw.result, "decision", "allow");
  });
  const result = await dispatchHook(stop, emitter, { cwd: "/tmp" }, record);
  expect(result.stdout).toBe('{"decision":"block","reason":"stay"}\n');
});

test("C-HOOK-23 blocked Stop stays running through the real Codex bridge", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({
    cwd,
    hooks: { Stop: () => ({ decision: "block", reason: "stay" }) },
  });
  try {
    session.on("activity", (event) => {
      if (event.kind !== "hook_result") return;
      const raw = event.raw as { result: object };
      Reflect.set(raw.result, "decision", "allow");
    });
    await session.sendPrompt("busy");
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, { ...stop, cwd });
    expect(result.stdout).toBe('{"decision":"block","reason":"stay"}\n');
    expect(session.status).toBe("running");
  } finally {
    await session.teardown();
  }
});

test("C-HOOK-23 Codex rejects accessor response data without reading it", async () => {
  const emitter = new TypedEmitter<CodexEventMap>();
  const errors: string[] = [];
  let accessed = false;
  const response = Object.defineProperty({ decision: "block" }, "reason", {
    enumerable: true,
    get() {
      accessed = true;
      return "secret";
    },
  });
  emitter.on("hook:Stop", () => response as never);
  emitter.on("hookError", (error) => errors.push(error.category));
  const result = await dispatchHook(stop, emitter, { cwd: "/tmp" }, record);
  expect(result.stdout).toBe("");
  expect(errors).toEqual(["invalid_response"]);
  expect(accessed).toBe(false);
});
