/** Lazy public question snapshots bypass ergonomic turn serialization (C-QUESTION-01). */
import { expect, test, vi } from "vitest";
import { TestSimple } from "../simple-fakes.ts";
import { definitions, registry } from "./helpers.ts";

test("C-QUESTION-01 listing lazily starts once and delegates the exact immutable snapshot", async () => {
  const facade = new TestSimple();
  const request = registry().publish("native", "blocking", [definitions[0]!])!;
  const requests = Object.freeze([request]);
  const list = vi.spyOn(facade.underlying, "listQuestions").mockResolvedValue(requests);
  try {
    expect(await facade.listQuestions()).toBe(requests);
    expect(list).toHaveBeenCalledExactlyOnceWith();
    expect(facade.launches).toBe(1);
    expect(await facade.listQuestions()).toBe(requests);
    expect(facade.launches).toBe(1);
  } finally {
    await facade.close();
  }
});
