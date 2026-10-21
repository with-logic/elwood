/** Pending native output settles before guarded input (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import { disposeTransactionHarnesses, transactionHarness as setup } from "./transaction-helpers.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await disposeTransactionHarnesses();
});
test("initial native output settles before the driver reads or writes", async () => {
  const h = setup((io) => io.write("\r", (frame) => frame.text.includes("native question")));
  const rendering = h.terminal.writeOutput("native question");
  const pending = h.transaction.run(h.adapter, h.request.id, h.answers, { timeoutMs: 500 });
  const settled = pending.catch((error) => error);
  await rendering;
  await expect.poll(() => h.writes).toContain("\r");
  h.requests.close(h.request.id, "answered");
  expect(await settled).toBeUndefined();
  expect(h.writes).toEqual(["\r"]);
});
test.each([
  "caller",
  "closing",
] as const)("%s revokes the initial pending-render wait", async (reason) => {
  let entered = false;
  const h = setup((io) => {
    entered = true;
    return io.write("\r", () => true);
  });
  const write = h.terminal.xterm.write.bind(h.terminal.xterm);
  let release = () => {};
  vi.spyOn(h.terminal.xterm, "write").mockImplementationOnce((data, callback) => {
    release = () => write(data, callback);
  });
  const rendering = h.terminal.writeOutput("native question");
  const pending = h.transaction.run(h.adapter, h.request.id, h.answers, { timeoutMs: 500 });
  const rejected = expect(pending).rejects.toMatchObject({ code: "question_answer_failed" });
  if (reason === "caller") await h.input.caller.sendInput("human");
  else h.closing.abort();
  await rejected;
  expect(entered).toBe(false);
  expect(h.writes).toEqual(reason === "caller" ? ["human"] : []);
  release();
  await rendering;
});

test("native acceptance while a write waits for render removes its authority", async () => {
  let release: (() => void) | undefined;
  let rendering: Promise<void> | undefined;
  const h = setup(async (io) => {
    const write = h.terminal.xterm.write.bind(h.terminal.xterm);
    vi.spyOn(h.terminal.xterm, "write").mockImplementationOnce((data, callback) => {
      release = () => write(data, callback);
    });
    rendering = h.terminal.writeOutput(" changed native frame");
    await io.write("\r", () => true);
  });
  await h.terminal.writeOutput("native question");
  const pending = h.transaction.run(h.adapter, h.request.id, h.answers, { timeoutMs: 500 });
  const rejected = expect(pending).rejects.toMatchObject({ code: "question_answer_failed" });
  await expect.poll(() => release).toBeDefined();
  h.requests.close(h.request.id, "answered");
  release!();
  await rendering;
  await rejected;
  expect(h.writes).toEqual([]);
  expect(h.transaction.busy()).toBe(false);
});
