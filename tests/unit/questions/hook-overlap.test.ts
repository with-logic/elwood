/** Independent Claude hook outcomes preserve native identities across interleavings (C-QUESTION-01). */
import { expect, test } from "vitest";
import { ClaudeQuestionHookGate } from "../../../src/claude/questions/hook-decisions.ts";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import { QuestionObserverFailure } from "../../../src/core/questions/notification-errors.ts";
import { fixture, frame, registry } from "./helpers.ts";
import { composer, nativeHook, nativeQuestions } from "./lifecycle-helpers.ts";

function hook(id: string | undefined, copy = id ?? "first", name = "PreToolUse") {
  return nativeHook(name, {
    tool_use_id: id,
    tool_input: {
      questions: nativeQuestions.map((q) => ({ ...q, question: `${copy} ${q.question}` })),
    },
  });
}
function paint(copy: string) {
  return frame(
    fixture("questions").text.replaceAll("Which test color?", `${copy} Which test color?`),
  );
}
function setup() {
  const requests = registry();
  const gate = new ClaudeQuestionHookGate(new ClaudeQuestionAdapter(requests));
  return { requests, gate };
}

test.each([
  ["first", "first"],
  ["first", "second"],
  ["second", "first"],
  ["second", "second"],
])("C-QUESTION-01 overlapping outcomes resolved %s first and completed %s first preserve both requests", (resolvedFirst, completedFirst) => {
  const { requests, gate } = setup();
  const first = hook("first");
  const second = hook("second");
  const resolved = resolvedFirst === "first" ? first : second;
  const waiting = resolvedFirst === "first" ? second : first;
  const waitingId = resolvedFirst === "first" ? "second" : "first";
  gate.observe(first);
  gate.observe(second);
  gate.render(paint(resolvedFirst));
  expect(requests.list()).toEqual([]);
  gate.resolveHookResult(resolved.raw, undefined);
  expect(requests.list()).toEqual([]);
  gate.render(paint(resolvedFirst));
  const original = requests.list()[0]!;
  expect(original?.questions[0]?.prompt).toBe(`${resolvedFirst} Which test color?`);
  expect(requests.keyFor(original.id)).toBe(resolvedFirst);
  gate.render(paint(waitingId));
  expect(requests.list()).toEqual([original]);
  gate.resolveHookResult(waiting.raw, undefined);
  expect(requests.list()).toEqual([original]);
  gate.render(paint(waitingId));
  const both = requests.list();
  expect(both.map((request) => requests.keyFor(request.id))).toEqual([resolvedFirst, waitingId]);
  const survivor = both.find((request) => requests.keyFor(request.id) !== completedFirst)!;
  gate.observe(hook(completedFirst, completedFirst, "PostToolUse"));
  expect(requests.list()).toEqual([survivor]);
  expect(gate.blocksInput()).toBe(true);
  const lastId = completedFirst === "first" ? "second" : "first";
  gate.observe(hook(lastId, lastId, "PostToolUse"));
  expect(requests.list()).toEqual([]);
  gate.render(composer());
  expect(gate.blocksInput()).toBe(false);
});

test.each([
  "pre",
  "permission",
])("C-QUESTION-01 a matching mirror denial wins with %s outcome first", (firstOutcome) => {
  const { requests, gate } = setup();
  const pre = hook("pre");
  const permission = hook("mirror", "pre", "PermissionRequest");
  gate.observe(pre);
  gate.observe(permission);
  const resolvePre = () => gate.resolveHookResult(pre.raw, undefined);
  const resolvePermission = () => gate.resolveHookResult(permission.raw, { behavior: "deny" });
  if (firstOutcome === "pre") {
    resolvePre();
    resolvePermission();
  } else {
    resolvePermission();
    resolvePre();
  }
  gate.render(paint("pre"));
  expect(requests.list()).toEqual([]);
  expect(gate.blocksInput()).toBe(true);
  gate.observe(hook("pre", "pre", "PostToolUseFailure"));
  gate.render(composer());
  expect(gate.blocksInput()).toBe(false);
});

test.each([
  false,
  true,
])("C-QUESTION-01 identical simultaneous panels preserve ownership without choosing an identity, mirror denial=%s", (denyMirror) => {
  const { requests, gate } = setup();
  const first = hook("first");
  const second = hook("second", "first");
  gate.observe(first);
  gate.resolveHookResult(first.raw, undefined);
  gate.render(paint("first"));
  const original = requests.list()[0]!;
  gate.observe(second);
  gate.resolveHookResult(second.raw, undefined);
  gate.render(paint("first"));
  expect(requests.list()).toEqual([]);
  expect(requests.find("first")).toBe(original);
  if (denyMirror) {
    const mirror = hook(undefined, "first", "PermissionRequest");
    gate.observe(mirror);
    gate.resolveHookResult(mirror.raw, { behavior: "deny" });
  }
  gate.observe(hook(undefined, "first", "PostToolUse"));
  expect(requests.hasPending()).toBe(true);
  expect(gate.blocksInput()).toBe(true);
  gate.observe(hook("first", "first", "PostToolUse"));
  gate.render(paint("first"));
  expect(requests.list().map((request) => requests.keyFor(request.id))).toEqual(
    denyMirror ? [] : ["second"],
  );
  expect(gate.blocksInput()).toBe(true);
  gate.observe(hook("second", "first", "PostToolUse"));
  gate.render(composer());
  expect(gate.blocksInput()).toBe(false);
});

test("C-QUESTION-01 native completion before a late caller outcome cannot resurrect a request", () => {
  const { requests, gate } = setup();
  const pending = hook("first");
  gate.observe(pending);
  gate.observe(hook("first", "first", "PostToolUse"));
  gate.resolveHookResult(pending.raw, undefined);
  gate.render(paint("first"));
  expect(requests.list()).toEqual([]);
  gate.render(composer());
  expect(gate.blocksInput()).toBe(false);
});

test("C-QUESTION-01 overlapping composer retirement finishes before surfacing an observer failure", () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(hook("first"));
  adapter.render(paint("first"));
  adapter.observe(hook("second"));
  adapter.render(paint("second"));
  expect(requests.list()).toHaveLength(2);
  const failure = new Error("private observer cause");
  requests.onEvent((event) => {
    if (event.phase === "closed") throw failure;
  });
  let observed: unknown;
  try {
    adapter.render(composer());
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(QuestionObserverFailure);
  expect(observed).toMatchObject({ originalError: failure });
  expect(requests.list()).toEqual([]);
  expect(adapter.blocksInput()).toBe(false);
  const plain = new Error("plain render failure");
  expect(() =>
    adapter.render({
      ...composer(),
      get text(): string {
        throw plain;
      },
    }),
  ).toThrow(plain);
});

test("C-QUESTION-01 composer observers cannot delete a newer candidate through a stale snapshot", () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(hook("first"));
  adapter.render(paint("first"));
  adapter.observe(hook("second"));
  adapter.render(paint("second"));
  requests.onEvent((event) => {
    if (event.phase === "closed" && event.request.questions[0]?.prompt.startsWith("first "))
      adapter.observe(hook("second", "newer"));
  });
  adapter.render(composer());
  expect(requests.list()).toEqual([]);
  expect(adapter.blocksInput()).toBe(true);
  adapter.render(paint("newer"));
  expect(requests.list()[0]?.questions[0]?.prompt).toBe("newer Which test color?");
});
