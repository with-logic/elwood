/** Completed native frames guard question input, independent of transactions (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import { disposeInputHarnesses, inputHarness as setup } from "./input-helpers.ts";

afterEach(async () => {
  await disposeInputHarnesses();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("pending native output settles before write guard inspection", async () => {
  const h = setup();
  const rendering = h.terminal.writeOutput("native question");
  expect(h.io.frame()).toBeUndefined();
  const write = h.track(h.io.write("answer", (frame) => frame.text.includes("native question")));
  await rendering;
  await write;
  expect(h.writes).toEqual(["answer"]);
  expect(h.started).toHaveBeenCalledOnce();
  expect(h.failed).not.toHaveBeenCalled();
});

test("post-write waits require a later completed render", async () => {
  const h = setup();
  await h.terminal.writeOutput("question");
  await h.track(h.io.write("answer", () => true));
  vi.useFakeTimers();
  let observed = false;
  const pending = h.track(h.io.wait(() => true)).then((frame) => {
    observed = true;
    return frame;
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(observed).toBe(false);
  h.terminal.resize({ cols: 139, rows: 44 });
  await vi.advanceTimersByTimeAsync(0);
  expect(observed).toBe(false);
  const rendering = h.terminal.writeOutput(" accepted");
  await vi.advanceTimersByTimeAsync(0);
  await rendering;
  expect((await pending).text).toContain("accepted");
});

test.each([
  "caller",
  "closing",
] as const)("%s revokes pending rendering before any automated write", async (reason) => {
  const h = setup();
  const write = h.terminal.xterm.write.bind(h.terminal.xterm);
  let release = () => {};
  vi.spyOn(h.terminal.xterm, "write").mockImplementationOnce((data, callback) => {
    release = () => write(data, callback);
  });
  const rendering = h.terminal.writeOutput("question");
  try {
    const pending = h.track(h.io.write("forbidden", () => true));
    const rejected = pending.catch((error: unknown) => error);
    if (reason === "caller") await h.input.caller.sendInput("human");
    else h.closing.abort();
    expect(await rejected).toBe(h.io.signal.reason);
    expect(h.writes).toEqual(reason === "caller" ? ["human"] : []);
    expect(h.started).not.toHaveBeenCalled();
  } finally {
    release();
    await rendering;
  }
});

test("foreign frames and closed request ownership make zero writes", async () => {
  const h = setup();
  await h.terminal.writeOutput("foreign frame");
  await expect(h.io.write("forbidden", () => false)).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  h.requests.close(h.request.id, "answered");
  await expect(h.io.write("forbidden", () => true)).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  expect(h.writes).toEqual([]);
  expect(h.started).not.toHaveBeenCalled();
});

test("request closure while rendering settles removes write authority", async () => {
  const h = setup();
  const rendering = h.terminal.writeOutput("question");
  const pending = h.track(h.io.write("forbidden", () => true));
  h.requests.close(h.request.id, "answered");
  await rendering;
  await expect(pending).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(h.writes).toEqual([]);
});
