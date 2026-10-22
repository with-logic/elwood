/** Permission mirrors withdraw automation while preserving native correlation (PRD §6). */
import { expect, test } from "vitest";
import { ClaudeQuestionHookGate } from "../../../src/claude/questions/hook-decisions.ts";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { definitions, fixture, frame, registry } from "./helpers.ts";
import { nativeHook } from "./lifecycle-helpers.ts";

const decisions = [
  { behavior: "allow", updatedInput: { answers: { Color: "Amber" } } },
  { behavior: "deny" },
] as const;
test.each(
  [false, true].flatMap((exposed) => decisions.map((result) => ({ exposed, result }))),
)("different-ID matching PermissionRequest withdraws exposed=$exposed with $result.behavior", ({
  exposed,
  result,
}) => {
  const requests = registry();
  const gate = new ClaudeQuestionHookGate(new ClaudeQuestionAdapter(requests));
  const events: ElwoodQuestionEvent[] = [];
  requests.onEvent((event) => events.push(event));
  const pre = nativeHook();
  gate.observe(pre);
  gate.resolveHookResult(pre.raw, undefined);
  if (exposed) gate.render(fixture("questions"));
  const original = requests.list()[0];
  if (exposed) {
    expect(original).toBeDefined();
    expect(requests.keyFor(original!.id)).toBe("native");
    expect(original!.questions).toMatchObject(definitions);
  }
  const permission = nativeHook("PermissionRequest", { tool_use_id: "permission-mirror" });
  gate.observe(permission);
  gate.resolveHookResult(permission.raw, result);
  gate.render(fixture("questions"));
  expect(requests.list()).toEqual([]);
  expect(requests.find("permission-mirror")).toBeUndefined();
  if (original) {
    expect(requests.get(original.id)).toBeUndefined();
    expect(requests.find("native")).toBe(original);
    expect(original.questions).toMatchObject(definitions);
  }
  expect(requests.hasPending()).toBe(exposed);
  expect(events).toEqual(
    exposed
      ? [
          expect.objectContaining({ phase: "raised", request: original }),
          expect.objectContaining({ phase: "closed", request: original, reason: "unavailable" }),
        ]
      : [],
  );
  const eventCount = events.length;
  expect(gate.observe(nativeHook("PostToolUse", { tool_use_id: "permission-mirror" }))).toBe(false);
  gate.render(frame("Waiting for native hook."));
  expect(gate.blocksInput()).toBe(true);
  expect(requests.hasPending()).toBe(exposed);
  if (original) expect(requests.find("native")).toBe(original);
  expect(events).toHaveLength(eventCount);
  expect(gate.observe(nativeHook("PostToolUse"))).toBe(true);
  gate.render(frame("Waiting for native hook."));
  expect(gate.blocksInput()).toBe(false);
  expect(requests.hasPending()).toBe(false);
  expect(requests.find("native")).toBeUndefined();
  expect(events).toHaveLength(eventCount);
});
