/** Navigation rejects lost ownership/layout and revisits a highlighted choice safely (PRD §4). */
import { expect, test } from "vitest";
import { questionNavigation } from "../../../src/claude/questions/navigation.ts";
import type { QuestionIo } from "../../../src/core/questions/adapter.ts";
import { definitions, fixture, frame, registry } from "./helpers.ts";

test("validates frames and uses Up for an earlier choice", async () => {
  const request = registry().publish("native", "blocking", definitions)!;
  let current: ReturnType<typeof frame> | undefined = fixture("color-blue-highlight");
  const writes: string[] = [];
  const io: QuestionIo = {
    signal: new AbortController().signal,
    frame: () => current,
    write: (input, expected) => {
      if (!expected(current!)) throw new Error("invalid write");
      writes.push(input);
      current = fixture("questions");
      return Promise.resolve();
    },
    wait: (predicate) => {
      if (!predicate(current!)) throw new Error("invalid wait");
      return Promise.resolve(current!);
    },
  };
  const navigation = questionNavigation(request, 0, io);
  expect(navigation.at(fixture("features-initial"))).toBeUndefined();
  expect(navigation.at(frame("foreign"))).toBeUndefined();
  await navigation.move(0);
  expect(writes).toEqual(["\x1b[A"]);
  current = undefined;
  expect(() => navigation.read()).toThrowError(
    expect.objectContaining({ code: "question_answer_failed" }),
  );
  current = frame("foreign");
  await expect(navigation.move(0)).rejects.toMatchObject({ code: "question_answer_failed" });
});
