/** Codex hook notifications preserve decisions and diagnostics (PRD §7A.2, C-HOOK-22). */
import { expect, test, vi } from "vitest";
import { buildCodexHookErrorHandler, dispatchHook } from "../../src/codex/session/hooks.ts";
import type { CodexEventMap } from "../../src/codex/session/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { createSessionRecord } from "../../src/state/store.ts";

const record = createSessionRecord({ id: "codex-observer", cwd: "/tmp", adapter: "codex" });
const stop = {
  hook_event_name: "Stop",
  session_id: "codex-1",
  cwd: "/tmp",
  turn_id: "turn-1",
  stop_hook_active: false,
} as const;

for (const phase of ["hook", "activity", "hook_error"] as const) {
  test(`C-HOOK-22 Codex ${phase} observer failure preserves the hook reply`, async () => {
    const emitter = new TypedEmitter<CodexEventMap>();
    const warnings: CodexEventMap["warning"][] = [];
    emitter.on("warning", (warning) => warnings.push(warning));
    emitter.on(phase === "hook_error" ? "hookError" : phase, () => {
      throw new Error("private observer data");
    });
    if (phase === "hook_error") emitter.on("hook:Stop", () => ({}) as never);
    else emitter.on("hook:Stop", () => ({ decision: "block", reason: "retained" }));
    const result = await dispatchHook(stop, emitter, { cwd: "/tmp" }, record);
    expect(result).toEqual({
      exitCode: 0,
      stdout: phase === "hook_error" ? "" : '{"decision":"block","reason":"retained"}\n',
      stderr: "",
    });
    expect(warnings).toEqual([
      expect.objectContaining({ agent: "codex", code: "hook_observer_failed", phase }),
    ]);
    expect(JSON.stringify(warnings)).not.toContain("private");
  });
}

test("C-HOOK-22 Codex async observer rejection is consumed without delaying reply", async () => {
  const emitter = new TypedEmitter<CodexEventMap>();
  const warnings: CodexEventMap["warning"][] = [];
  emitter.on("warning", (warning) => warnings.push(warning));
  emitter.on("hook", () => Promise.reject(new Error("private async observer")));
  emitter.on("hook:Stop", () => ({ decision: "block", reason: "retained" }));
  const result = await dispatchHook(stop, emitter, { cwd: "/tmp" }, record);
  expect(result.stdout).toContain("retained");
  await vi.waitFor(() => expect(warnings).toHaveLength(1));
  expect(warnings[0]).toMatchObject({ phase: "hook", agent: "codex" });
});

test("C-HOOK-22 Codex bridge-error observers are isolated and warning failures do not recurse", () => {
  const emitter = new TypedEmitter<CodexEventMap>();
  const seen: string[] = [];
  emitter.on("hookError", () => {
    throw new Error("private bridge observer");
  });
  emitter.on("activity", (event) => seen.push(event.kind));
  emitter.on("warning", (event) => {
    seen.push(event.code);
    throw new Error("private warning observer");
  });
  const onError = buildCodexHookErrorHandler(record, emitter);
  expect(() =>
    onError({ hookEventName: "Unknown", category: "bridge_error", message: "bridge failed" }),
  ).not.toThrow();
  expect(seen).toEqual(["hook_error", "hook_observer_failed", "warning"]);
});
