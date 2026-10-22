/** Correlated hook decisions precede native question publication (PRD §6). */
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeQuestionHookGate } from "../../../src/claude/questions/hook-decisions.ts";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import { definitions, fixture, registry } from "./helpers.ts";
import { disposeInputHarnesses, inputHarness } from "./input-helpers.ts";
import { nativeHook, singleQuestionToolInput } from "./lifecycle-helpers.ts";

afterEach(disposeInputHarnesses);

function setup() {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  const gate = new ClaudeQuestionHookGate(adapter);
  return { gate, requests, adapter };
}

test.each([
  "PreToolUse",
  "PermissionRequest",
])("%s direct answers or denial never publish a matching stale panel", (name) => {
  for (const result of [
    { permissionDecision: "allow", updatedInput: { answers: { Color: "Amber" } } },
    { behavior: "allow", updatedInput: { answers: { Color: "Amber" } } },
    { permissionDecision: "allow", updatedInput: { answers: { Color: "" } } },
    { behavior: "allow", updatedInput: { answers: { Color: "" } } },
    { permissionDecision: "deny" },
    { behavior: "deny" },
  ] as const) {
    const { gate, requests } = setup();
    const hook = nativeHook(name);
    gate.observe(hook);
    expect(gate.blocksInput()).toBe(true);
    gate.render(fixture("questions"));
    expect(requests.list()).toEqual([]);
    gate.resolveHookResult(hook.raw, result);
    gate.render(fixture("questions"));
    expect(requests.list()).toEqual([]);
  }
});

test("only the newest correlated unanswered hook can publish on a fresh completed frame", () => {
  const { gate, requests } = setup();
  const old = nativeHook();
  const current = nativeHook("PermissionRequest", { tool_use_id: "new" });
  gate.resolveHookResult(old.raw, undefined);
  expect(gate.blocksInput()).toBe(false);
  gate.observe({ ...old, source: "transcript", kind: "hook" });
  gate.observe({ ...old, kind: "hook_result", hookEventName: "PreToolUse" });
  gate.observe(nativeHook("PostToolUse"));
  gate.observe(old);
  gate.observe(current);
  gate.observe(nativeHook("PreToolUse", { tool_name: "Bash" }));
  gate.resolveHookResult(structuredClone(current.raw), undefined);
  gate.resolveHookResult(old.raw, { permissionDecision: "deny" });
  gate.render(fixture("questions"));
  expect(requests.list()).toEqual([]);
  gate.resolveHookResult(current.raw, { behavior: "allow", updatedInput: { answers: {} } });
  expect(requests.list()).toEqual([]);
  gate.render(fixture("questions"));
  expect(requests.list()).toHaveLength(1);
  expect(requests.keyFor(requests.list()[0]!.id)).toBe("new");
  expect(requests.find("native")).toBeUndefined();
  expect(gate.blocksInput()).toBe(true);
});

test("blocked Stop retains pending authority; unblocked Stop invalidates its late outcome", () => {
  const { gate, requests } = setup();
  const hook = nativeHook();
  const stop = { ...nativeHook(), kind: "hook_result", hookEventName: "Stop" } as const;
  gate.observe(hook);
  gate.observe({ ...stop, raw: { result: { decision: "block" } } });
  expect(gate.blocksInput()).toBe(true);
  gate.observe({ ...stop, raw: { result: undefined } });
  expect(gate.blocksInput()).toBe(false);
  gate.resolveHookResult(hook.raw, undefined);
  gate.render(fixture("questions"));
  expect(requests.list()).toEqual([]);
});

test("answer forwarding retains native ownership checks", async () => {
  const { gate } = setup();
  const h = inputHarness();
  await expect(gate.answer(h.request, [], h.io)).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  expect(h.writes).toEqual([]);
});

test("an owned request forwards the exact answer arguments through the gate", async () => {
  const { gate, requests, adapter } = setup();
  const hook = nativeHook();
  gate.observe(hook);
  gate.resolveHookResult(hook.raw, undefined);
  gate.render(fixture("questions"));
  const request = requests.list()[0]!;
  expect(requests.keyFor(request.id)).toBe("native");
  const h = inputHarness();
  const answers = [{ optionIndexes: [1] }, { optionIndexes: [0, 1] }] as const;
  const answer = vi.spyOn(adapter, "answer").mockResolvedValue();
  await expect(gate.answer(request, answers, h.io)).resolves.toBeUndefined();
  expect(answer).toHaveBeenCalledExactlyOnceWith(request, answers, h.io);
  expect(answer.mock.calls[0]?.[0]).toBe(request);
  expect(answer.mock.calls[0]?.[1]).toBe(answers);
  expect(answer.mock.calls[0]?.[2]).toBe(h.io);
});

test.each([
  false,
  true,
])("a direct PermissionRequest withdraws earlier metadata without claiming native acceptance, exposed=%s", (exposed) => {
  const { gate, requests } = setup();
  const events: unknown[] = [];
  requests.onEvent((event) => events.push(event));
  const pre = nativeHook();
  gate.observe(pre);
  gate.resolveHookResult(pre.raw, undefined);
  if (exposed) gate.render(fixture("questions"));
  const request = requests.list()[0];
  const permission = nativeHook("PermissionRequest");
  gate.observe(permission);
  gate.resolveHookResult(permission.raw, {
    behavior: "allow",
    updatedInput: { answers: { Color: "Amber" } },
  });
  gate.render(fixture("questions"));
  expect(requests.list()).toEqual([]);
  expect(gate.blocksInput()).toBe(true);
  if (request) {
    expect(requests.get(request.id)).toBeUndefined();
    expect(requests.find("native")).toBe(request);
    expect(requests.hasPending()).toBe(true);
  }
  expect(events).toEqual(
    exposed
      ? [
          expect.objectContaining({ phase: "raised" }),
          expect.objectContaining({ phase: "closed", reason: "unavailable" }),
        ]
      : [],
  );
  const eventCount = events.length;
  gate.observe(nativeHook("PostToolUse"));
  expect(requests.hasPending()).toBe(false);
  expect(events).toHaveLength(eventCount);
});

test.each([
  { tool_use_id: "foreign", tool_input: singleQuestionToolInput },
  { tool_use_id: undefined, tool_input: {} },
  { tool_use_id: undefined, tool_input: { questions: [] } },
])("a direct decision for foreign or invalid metadata cannot withdraw another native request: %j", (extra) => {
  const { gate, requests } = setup();
  const pre = nativeHook();
  gate.observe(pre);
  gate.resolveHookResult(pre.raw, undefined);
  gate.render(fixture("questions"));
  const original = requests.list()[0]!;
  expect(requests.keyFor(original.id)).toBe("native");
  expect(original.questions).toMatchObject(definitions);
  const foreign = nativeHook("PermissionRequest", extra);
  gate.observe(foreign);
  gate.resolveHookResult(foreign.raw, { behavior: "deny" });
  gate.render(fixture("questions"));
  expect(requests.list()).toEqual([original]);
  expect(requests.get(original.id)).toBe(original);
  expect(requests.keyFor(original.id)).toBe("native");
  expect(requests.find("foreign")).toBeUndefined();
  expect(original.questions).toMatchObject(definitions);
});
test("an ID-less matching permission decision withdraws the native candidate", () => {
  const { gate, requests } = setup();
  const pre = nativeHook();
  gate.observe(pre);
  gate.resolveHookResult(pre.raw, undefined);
  const permission = nativeHook("PermissionRequest", { tool_use_id: undefined });
  gate.observe(permission);
  gate.resolveHookResult(permission.raw, { behavior: "deny" });
  gate.render(fixture("questions"));
  expect(requests.list()).toEqual([]);
});
