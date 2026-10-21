/** Pending native output is transient; answer input waits for completed frames (C-QUESTION-02). */
import { afterEach, expect, test, vi } from "vitest";
import type { QuestionAdapter, QuestionIo } from "../../../src/core/questions/adapter.ts";
import { QuestionTransaction } from "../../../src/core/questions/transaction.ts";
import { PickerInputOwnership } from "../../../src/runtime/session/picker-input.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { definitions, registry } from "./helpers.ts";

const terminals: ReturnType<typeof createHeadlessTerminal>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const terminal of terminals.splice(0)) terminal.dispose();
});
function setup(answer: (io: QuestionIo) => Promise<void>) {
  const writes: string[] = [];
  const terminal = createHeadlessTerminal({ cols: 140, rows: 45 }, (input) =>
    writes.push(String(input)),
  );
  terminals.push(terminal);
  const ownership = new PickerInputOwnership(terminal);
  const closing = new AbortController();
  const requests = registry();
  const request = requests.publish("native", "blocking", [definitions[0]!]);
  const answers = [
    { questionId: request.questions[0]!.id, optionIds: [request.questions[0]!.options[0]!.id] },
  ];
  const adapter: QuestionAdapter = {
    observe: () => {},
    render: () => {},
    blocksInput: () => true,
    answer: (_request, _answers, io) => answer(io),
  };
  const transaction = new QuestionTransaction(
    requests,
    ownership.automated,
    () => ownership.signal(),
    closing.signal,
  );
  return { writes, terminal, ownership, closing, requests, request, answers, adapter, transaction };
}
test("C-QUESTION-02 initial native output settles before the driver reads or writes", async () => {
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
test("C-QUESTION-02 a pulse received just before write settles and is revalidated once", async () => {
  const h = setup(async (io) => {
    const rendering = h.terminal.writeOutput(" updated");
    await io.write("\r", (frame) => frame.text.includes("question updated"));
    await rendering;
  });
  await h.terminal.writeOutput("native question");
  const pending = h.transaction.run(h.adapter, h.request.id, h.answers, { timeoutMs: 500 });
  const settled = pending.catch((error) => error);
  await expect.poll(() => h.writes).toContain("\r");
  h.requests.close(h.request.id, "answered");
  expect(await settled).toBeUndefined();
  expect(h.writes).toEqual(["\r"]);
});
test.each([
  "caller",
  "closing",
] as const)("C-QUESTION-02 %s revokes the initial pending-render wait", async (reason) => {
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
  await new Promise((resolve) => setTimeout(resolve, 5));
  if (reason === "caller") await h.ownership.caller.sendInput("human");
  else h.closing.abort();
  await rejected;
  expect(entered).toBe(false);
  expect(h.writes).toEqual(reason === "caller" ? ["human"] : []);
  release();
  await rendering;
});

test("C-QUESTION-02 invalid runtime signals reject without wedging the next answer", async () => {
  const h = setup(async (io) => {
    await io.write("\r", () => true);
    h.requests.close(h.request.id, "answered");
  });
  await h.terminal.writeOutput("native question");
  const invalid = Reflect.apply(h.transaction.run, h.transaction, [
    h.adapter,
    h.request.id,
    h.answers,
    { signal: {} },
  ]);
  await expect(invalid).rejects.toMatchObject({ code: "invalid_question_answer" });
  expect(h.writes).toEqual([]);
  expect(h.transaction.busy()).toBe(false);
  await h.transaction.run(h.adapter, h.request.id, h.answers);
  expect(h.writes).toEqual(["\r"]);
  expect(h.transaction.busy()).toBe(false);
  expect(h.requests.list()).toEqual([]);
});

test("C-QUESTION-02 native acceptance while a write waits for render removes its authority", async () => {
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
