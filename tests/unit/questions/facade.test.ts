/** Native question controls bypass ergonomic turn serialization (C-QUESTION-02). */
import { expect, test, vi } from "vitest";
import { questionActivity } from "../../../src/core/questions/activity-fields.ts";
import { activity, TestSimple } from "../simple-fakes.ts";
import { definitions, registry } from "./helpers.ts";

test("C-QUESTION-02 lazy question methods faithfully delegate independently of turns", async () => {
  const facade = new TestSimple();
  const request = registry().publish("distinct-native-request", "blocking", [definitions[0]!])!;
  const list = vi.spyOn(facade.underlying, "listQuestions").mockResolvedValue([request]);
  expect(await facade.listQuestions()).toEqual([request]);
  expect(list).toHaveBeenCalledExactlyOnceWith();
  expect(facade.launches).toBe(1);
  const answers = [{ questionId: "question", text: "answer" }];
  const options = { timeoutMs: 100 };
  await facade.answerQuestions("request", answers, options);
  expect(facade.launches).toBe(1);
  expect(facade.underlying.args["answerQuestions"]).toEqual(["request", answers, options]);
  await facade.close();
});

test("C-QUESTION-02 a live ergonomic turn remains owned while question controls run", async () => {
  const facade = new TestSimple();
  facade.underlying.script = (emitter) => {
    emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
    emitter.emit(
      "activity",
      questionActivity({
        elwoodSessionId: "s1",
        agent: "claude",
        phase: "raised",
        request: { id: "request", agent: "claude", delivery: "blocking", questions: [] },
      }),
    );
  };
  const pending = facade.send("ask", { timeoutMs: 5000 });
  await expect.poll(() => facade.underlying.sends).toBe(1);
  await facade.answerQuestions("request", [{ questionId: "question", text: "answer" }]);
  facade.underlying.emitter.emit(
    "activity",
    activity({ kind: "assistant_message", text: "Final answer", turnId: "t1" }),
  );
  facade.underlying.emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
  expect(await pending).toBe("Final answer");
  await facade.close();
});
