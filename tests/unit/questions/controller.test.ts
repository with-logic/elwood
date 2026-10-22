/** Private discovery follows completed renders and changed activity (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import type { ElwoodActivityEvent } from "../../../src/core/activity/index.ts";
import { disposeTerminals, controllerHarness as setup } from "./controller-helpers.ts";
import { definitions } from "./helpers.ts";

afterEach(disposeTerminals);
test("completed renders discover questions despite throwing observers", async () => {
  const h = setup();
  expect(h.questions.blocksInput()).toBe(false);
  const frames: string[] = [];
  h.questions.configure((registry) => ({
    ...h.adapter,
    render: (frame) => {
      frames.push(frame.text.trim());
      if (frame.text.includes("native question"))
        registry.publish("native", "blocking", definitions);
    },
  }));
  h.events.on("question", () => {
    throw new Error("consumer");
  });
  h.activity();
  await h.terminal.writeOutput("native question");
  expect(h.terminal.renderFailed).toBe(false);
  expect(frames).toEqual(["native question"]);
  expect(h.questions.list()).toHaveLength(1);
  await h.terminal.writeOutput("\r\x1b[2Kupdated native question");
  expect(frames).toEqual(["native question", "updated native question"]);
  expect(h.questions.list()).toHaveLength(1);
  expect(h.questions.blocksInput()).toBe(true);
  h.questions.revoke();
  h.closing.abort();
  expect(h.questions.list()).toEqual([]);
});
test("only changed activity and completed renders refresh the adapter once", async () => {
  const h = setup();
  const observe = vi.fn((event: ElwoodActivityEvent) => event.label === "changed");
  const render = vi.fn();
  h.questions.configure(() => ({ ...h.adapter, observe, render }));
  h.activity(); // No completed frame yet.
  expect(render).not.toHaveBeenCalled();
  await h.terminal.writeOutput("question");
  expect(render).toHaveBeenCalledTimes(1);
  for (let index = 0; index < 3; index++) h.activity("unrelated");
  h.events.emit("terminal:data", { elwoodSessionId: "s", data: "question" });
  expect(render).toHaveBeenCalledTimes(1);
  h.activity();
  expect(render).toHaveBeenCalledTimes(2);
  const observed = observe.mock.calls.length;
  h.questions.registry.publish("one", "queued", definitions);
  expect(observe).toHaveBeenCalledTimes(observed);
  await h.terminal.writeOutput(" redraw");
  expect(render).toHaveBeenCalledTimes(3);
  h.closing.abort();
  h.activity();
  await h.terminal.writeOutput(" after shutdown");
  expect(render).toHaveBeenCalledTimes(3);
});
test("activity before configuration is ignored, then reaches the configured adapter", async () => {
  const h = setup();
  const observe = vi.fn(() => true);
  const render = vi.fn();
  await h.terminal.writeOutput("native question");
  expect(() => h.activity()).not.toThrow();
  expect(h.adapter.observe).not.toHaveBeenCalled();
  h.questions.configure(() => ({ ...h.adapter, observe, render }));
  expect(observe).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
  h.activity();
  expect(observe).toHaveBeenCalledOnce();
  expect(render).toHaveBeenCalledOnce();
  expect(render.mock.calls[0]?.[0]).toMatchObject({
    text: expect.stringContaining("native question"),
  });
  h.closing.abort();
});
test("shutdown during observation prevents a reentrant replacement refresh", async () => {
  const h = setup();
  const request = h.questions.registry.publish("one", "queued", definitions)!;
  await h.terminal.writeOutput("native question");
  const render = vi.fn();
  h.questions.configure((registry) => ({
    ...h.adapter,
    render,
    observe: () => {
      registry.close(request.id, "unavailable");
      return true;
    },
  }));
  h.events.on("question", (event) => {
    if (event.phase === "closed") h.closing.abort();
  });
  h.activity();
  expect(render).not.toHaveBeenCalled();
  expect(h.questions.list()).toEqual([]);
});
test("shutdown on first publication latches the registry before the render continues", async () => {
  const h = setup();
  h.questions.configure((registry) => ({
    ...h.adapter,
    render: () => {
      registry.publish("one", "queued", definitions);
      registry.publish("two", "queued", definitions);
    },
  }));
  const raised: string[] = [];
  h.events.on("question", (event) => {
    if (event.phase === "raised") {
      raised.push(event.request.id);
      h.closing.abort();
    }
  });
  await h.terminal.writeOutput("native question");
  expect(raised).toHaveLength(1);
  expect(h.questions.list()).toEqual([]);
});
test("shutdown retires all requests despite throwing closed observers", () => {
  const h = setup();
  h.questions.registry.publish("one", "queued", definitions);
  h.questions.registry.publish("two", "queued", definitions);
  let closed = 0;
  h.events.on("question", (event) => {
    if (event.phase === "closed") {
      closed++;
      throw new Error("consumer");
    }
  });
  h.closing.abort();
  expect(closed).toBe(2);
  expect(h.questions.list()).toEqual([]);
});
test("already-closed sessions cannot configure or publish", () => {
  const closing = new AbortController();
  closing.abort();
  const h = setup({ closing });
  const factory = vi.fn(() => h.adapter);
  h.questions.configure(factory);
  expect(factory).not.toHaveBeenCalled();
  expect(h.questions.registry.publish("late", "queued", definitions)).toBeUndefined();
});
test("answer delegates to the guarded lane and adapter holds ordinary input", async () => {
  const h = setup();
  h.questions.configure((registry) => ({
    ...h.adapter,
    blocksInput: () => true,
    answer: async (request, _answers, io) => {
      expect(h.questions.blocksInput()).toBe(true);
      await io.write("\r", () => true);
      registry.close(request.id, "answered");
    },
  }));
  expect(h.questions.blocksInput()).toBe(true);
  const request = h.questions.registry.publish("one", "blocking", definitions.slice(0, 1))!;
  await h.terminal.writeOutput("question");
  await h.questions.answer(request.id, [
    {
      questionId: request.questions[0]!.id,
      optionIds: [request.questions[0]!.options[0]!.id],
    },
  ]);
  expect(h.questions.list()).toEqual([]);
  h.closing.abort();
});
