/** Capture image ownership at every facade call (PRD §5.8, C-API-44). */
import { afterEach, expect, test, vi } from "vitest";
import type { SendOptions } from "../../src/core/images/types.ts";
import { defaultScript, TestSimple } from "./simple-fakes.ts";

afterEach(() => vi.restoreAllMocks());

test.each([
  "sendPrompt",
  "sendMessage",
  "sendGuidance",
  "send",
  "stream",
] as const)("C-API-44 %s captures bytes and paths before lazy start yields", async (method) => {
  const session = new TestSimple();
  const data = new Uint8Array([1, 2]);
  const cwd = vi.spyOn(process, "cwd").mockReturnValue("/first");
  const pending = session[method]("go", {
    images: [{ data, format: "png" }, { path: "a.png" }],
  });
  data[0] = 9;
  cwd.mockReturnValue("/second");
  if (method === "stream") {
    for await (const _event of pending as AsyncGenerator<unknown>) {
      /* Drain the turn. */
    }
  } else await pending;
  const options = session.underlying.args[
    method === "send" || method === "stream" ? "sendMessage" : method
  ]?.[1] as SendOptions;
  expect(options.images).toEqual([
    { data: new Uint8Array([1, 2]), format: "png" },
    { path: "/first/a.png" },
  ]);
  await session.close();
});

test.each([
  "sendPrompt",
  "sendMessage",
  "sendGuidance",
  "send",
  "stream",
] as const)("C-API-44 %s rejects invalid images before launching", async (method) => {
  const session = new TestSimple();
  const result = session[method]("go", { images: "bad" as never });
  const pending = method === "stream" ? (result as AsyncGenerator<unknown>).next() : result;
  await expect(pending).rejects.toMatchObject({ code: "invalid_image" });
  expect(session.launches).toBe(0);
});

test("C-API-44 a terminal facade rejects before validating image input", async () => {
  const session = new TestSimple();
  await session.start();
  session.underlying.status = "stopped";
  await expect(session.sendMessage("go", { images: "bad" as never })).rejects.toMatchObject({
    code: "session_not_running",
  });
  await expect(session.stream("go", { images: "bad" as never }).next()).rejects.toMatchObject({
    code: "session_not_running",
  });
});

test("C-API-44 a queued turn on a started facade owns its image bytes at the call", async () => {
  const session = new TestSimple();
  await session.start();
  let finishFirst = () => {};
  session.underlying.script = (emitter, turnId) => {
    if (turnId === "t1") finishFirst = () => defaultScript(emitter, turnId);
    else defaultScript(emitter, turnId);
  };
  const first = session.send("first");
  await vi.waitFor(() => expect(session.underlying.sends).toBe(1));
  const data = new Uint8Array([4, 5]);
  const second = session.send("second", { images: [{ data, format: "png" }] });
  data.fill(9);
  expect(session.underlying.sends).toBe(1);
  finishFirst();
  await Promise.all([first, second]);
  const options = session.underlying.args["sendMessage"]?.[1] as SendOptions;
  expect(options.images).toEqual([{ data: new Uint8Array([4, 5]), format: "png" }]);
  await session.close();
});
