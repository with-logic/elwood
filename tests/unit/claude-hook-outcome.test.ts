/** Private validated hook outcomes preserve public observation and caller decisions (PRD §6.4). */
import { expect, test } from "vitest";
import type { ClaudeHookEvent, ClaudeHookResult } from "../../src/claude/hooks/index.ts";
import { buildClaudeHookHandler } from "../../src/claude/session/hook-handler.ts";
import { TurnStateWatcher } from "../../src/core/turn-state.ts";
import type { ClaudeEventMap } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { initialReady } from "../../src/runtime/readiness/initial-ready.ts";
import { createSessionRecord } from "../../src/state/store.ts";
import { nativeQuestions } from "./questions/lifecycle-helpers.ts";

test.each([
  false,
  true,
])("validated original/outcome correlation is isolated from observer failure: %s", async (throws) => {
  const emitter = new TypedEmitter<ClaudeEventMap>();
  const order: string[] = [];
  const publicRaw: unknown[] = [];
  const warnings: unknown[] = [];
  const outcomes: Array<readonly [ClaudeHookEvent, ClaudeHookResult]> = [];
  emitter.on("activity", (event) => {
    order.push(event.kind);
    publicRaw.push(event.raw);
  });
  emitter.on("warning", (warning) => warnings.push(warning));
  emitter.listen(
    "hook:PreToolUse",
    () => {
      order.push("caller");
      return { permissionDecision: "allow", updatedInput: { answers: { Color: "Amber" } } };
    },
    "tool-keyed",
  );
  const handler = buildClaudeHookHandler({
    record: createSessionRecord({ id: "s", cwd: "/tmp" }),
    options: { cwd: "/tmp" },
    emitter,
    ready: initialReady(() => {}),
    transcriptWatcher: { scan: () => {} },
    getSession: () => undefined,
    getTurnWatcher: () => new TurnStateWatcher(),
    observeHookTranscript: () => {},
    onHookOutcome: (event, result) => {
      order.push("outcome");
      outcomes.push([event, result]);
      if (throws) throw new Error("private observer failure");
    },
  });
  const result = await handler({
    hook_event_name: "PreToolUse",
    session_id: "native",
    cwd: "/tmp",
    tool_name: "AskUserQuestion",
    tool_use_id: "tool",
    tool_input: { questions: nativeQuestions },
  });
  expect(order).toEqual([
    "hook",
    "caller",
    "hook_result",
    "outcome",
    ...(throws ? ["warning"] : []),
  ]);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]?.[0]).toBe(publicRaw[0]);
  expect(Object.isFrozen(outcomes[0]?.[0])).toBe(true);
  expect(publicRaw[1]).toEqual({
    hookEventName: "PreToolUse",
    result: outcomes[0]?.[1],
    failedOpen: false,
  });
  expect(JSON.parse(result.stdout)).toMatchObject({
    hookSpecificOutput: {
      permissionDecision: "allow",
      updatedInput: { answers: { Color: "Amber" } },
    },
  });
  expect(warnings).toEqual(
    throws ? [expect.objectContaining({ code: "hook_observer_failed", phase: "activity" })] : [],
  );
  expect(JSON.stringify(warnings)).not.toContain("private");
});
