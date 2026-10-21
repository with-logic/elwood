/** Metadata mirrors cannot revoke uncertain Claude native ownership (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import { controllerHarness, disposeTerminals } from "./controller-helpers.ts";
import { fixture, frame, registry } from "./helpers.ts";
import { composer, nativeHook, nativeQuestions } from "./lifecycle-helpers.ts";

afterEach(() => {
  disposeTerminals();
  vi.restoreAllMocks();
});
const changedQuestions = nativeQuestions.map((question) => ({
  ...question,
  question: `Changed ${question.question}`,
}));
const changedHook = (id = "native") =>
  nativeHook("PreToolUse", {
    tool_use_id: id,
    tool_input: { questions: changedQuestions },
  });
const changedScreen = fixture("questions").text.replaceAll("Which test", "Changed Which test");

test.each([
  "hook",
  "Stop",
  "composer",
])("retired Claude identity survives changed metadata until authoritative %s closure", async (closure) => {
  const h = controllerHarness();
  const phases: string[] = [];
  h.events.on("question", (event) => phases.push(event.phase));
  h.questions.configure((registry) => new ClaudeQuestionAdapter(registry));
  const paint = (text: string) =>
    h.terminal.writeOutput(`\u001b[2J\u001b[H${text.replaceAll("\n", "\r\n")}`);
  try {
    h.events.emit("activity", nativeHook());
    await paint(fixture("questions").text);
    const original = h.questions.list()[0]!;
    expect(original).toBeDefined();
    h.questions.registry.retireUnconfirmed(original.id);
    h.events.emit("activity", changedHook());
    await paint(changedScreen);
    expect(h.questions.list()).toEqual([]);
    expect(h.questions.registry.get(original.id)).toBeUndefined();
    expect(h.questions.registry.find("native")).toBe(original);
    expect(h.questions.registry.hasPending()).toBe(true);
    expect(h.questions.blocksInput()).toBe(true);
    const send = vi.spyOn(h.terminal, "sendInput");
    await expect(h.questions.answer(original.id, [])).rejects.toMatchObject({
      code: "question_not_found",
    });
    expect(send).not.toHaveBeenCalled();
    if (closure === "hook") h.events.emit("activity", nativeHook("PostToolUse"));
    if (closure === "Stop")
      h.events.emit("activity", {
        ...nativeHook("Stop"),
        kind: "hook_result",
        hookEventName: "Stop",
        raw: {},
      });
    await paint(`${composer().text}\u001b[3;3H\u001b[?25h`);
    expect(h.questions.registry.find("native")).toBeUndefined();
    expect(h.questions.registry.hasPending()).toBe(false);
    expect(h.questions.blocksInput()).toBe(false);
    expect(phases).toEqual(["raised", "closed"]);
    h.events.emit("activity", changedHook("next"));
    await paint(changedScreen);
    expect(h.questions.list()[0]?.questions[0]?.prompt).toBe(changedQuestions[0]!.question);
    expect(h.questions.list()[0]?.id).not.toBe(original.id);
  } finally {
    h.closing.abort();
  }
});

test.each([
  false,
  true,
])("Claude semantic replacement preserves active requests and genuinely new identity (retired: %s)", async (retired) => {
  const h = controllerHarness();
  h.questions.configure((registry) => new ClaudeQuestionAdapter(registry));
  try {
    h.events.emit("activity", nativeHook());
    await h.terminal.writeOutput(fixture("questions").text.replaceAll("\n", "\r\n"));
    const original = h.questions.list()[0]!;
    if (retired) h.questions.registry.retireUnconfirmed(original.id);
    h.events.emit("activity", changedHook(retired ? "next" : "native"));
    await h.terminal.writeOutput(`\u001b[2J\u001b[H${changedScreen.replaceAll("\n", "\r\n")}`);
    const replacement = h.questions.list()[0]!;
    expect(replacement).toBeDefined();
    expect(replacement.id).not.toBe(original.id);
    expect(replacement.questions[0]?.prompt).toBe(changedQuestions[0]!.question);
  } finally {
    h.closing.abort();
  }
});

test("unpublished Claude metadata can change before matching native publication", () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(nativeHook());
  adapter.observe(changedHook());
  adapter.render(frame(changedScreen));
  expect(requests.list()[0]?.questions[0]?.prompt).toBe(changedQuestions[0]!.question);
});
