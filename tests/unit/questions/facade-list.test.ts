/** Lazy public question snapshots bypass ergonomic turn serialization (C-QUESTION-01). */
import { expect, test, vi } from "vitest";
import { activity, TestSimple } from "../simple-fakes.ts";
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
    const entered = Promise.withResolvers<void>();
    facade.underlying.script = (emitter) => {
      emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
      entered.resolve();
    };
    let finished = false;
    const turn = facade.send("hold this turn").then(() => {
      finished = true;
    });
    await entered.promise;
    expect(await facade.listQuestions()).toBe(requests);
    expect(finished).toBe(false);
    facade.underlying.emitter.emit("activity", activity({ text: "done", turnId: "t1" }));
    facade.underlying.emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
    await turn;
    expect(facade.launches).toBe(1);
  } finally {
    await facade.close();
  }
});
