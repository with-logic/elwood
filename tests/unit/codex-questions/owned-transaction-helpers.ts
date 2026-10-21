/** Exercise physical owned pastes through the real adapter and transaction (PRD §4). */
import { afterEach } from "vitest";
import { QuestionTransaction } from "../../../src/core/questions/transaction.ts";
import { PickerInputOwnership } from "../../../src/runtime/session/picker-input.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { reply } from "./acceptance-helpers.ts";
import { harness } from "./adapter-helpers.ts";
import { nativeFrame } from "./native-frame.ts";
import { singleEmpty, typedChrome } from "./owned-chrome-fixtures.ts";
import {
  definitions,
  emptyLong,
  expected,
  type Mode,
  metadata,
  modalAcceptance,
  queuedAcceptance,
  selector,
} from "./owned-fixtures.ts";

const terminals: ReturnType<typeof createHeadlessTerminal>[] = [];
afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});
type BindingOptions = {
  readonly mode: Mode;
  readonly long: boolean;
  readonly wrong: boolean;
  readonly probe?: { readonly text: string; readonly timeoutMs?: number };
};
export async function transactionBinding(options: BindingOptions) {
  const { mode, long, wrong, probe } = options;
  const h = harness();
  const call = metadata(mode, probe ? 1 : 2);
  h.observe({ payload: call });
  if (mode === "queued")
    h.observe({
      payload: {
        type: "AgentMessage",
        id: call.call_id,
        delivery: "async",
        questions: definitions(mode)
          .slice(0, probe ? 1 : 2)
          .map(({ prompt }) => ({ title: prompt })),
      },
    });
  const values = probe ? { literal: probe.text, long: "" } : expected(mode);
  const queued = queuedAcceptance();
  const modal = modalAcceptance();
  if (mode === "queued" && long)
    h.adapter.observe(reply(queued.answers[0].questionItemId, queued.answers[0].answer));
  const literal = probe ? singleEmpty(mode) : nativeFrame(`editor/${mode}-literal-empty.json`);
  const modalLong = {
    ...literal,
    lines: literal.lines.map((line) =>
      line
        .replace("Question 1/2 (2 unanswered)", "Question 2/2 (1 unanswered)")
        .replace("ELWOOD_RAW_LITERAL: Enter the literal", "ELWOOD_RAW_LONG: Enter the long text")
        .replace("Proceed", "Short")
        .replace("Wait", "Long"),
    ),
  };
  const initial = mode === "modal" ? selector(literal) : long ? emptyLong() : literal;
  h.adapter.render(initial);
  const request = h.registry.list()[0]!;
  const writes: string[] = [];
  let index = 0;
  let acknowledge: (() => void) | undefined;
  const terminal = createHeadlessTerminal({ cols: 140, rows: 45 }, async (input) => {
    const text = String(input);
    writes.push(text);
    if (text === "\t") await paint(index === 0 ? literal : modalLong);
    if (text.startsWith("\x1b[200~"))
      await paint(
        probe
          ? typedChrome(mode, probe.text)
          : nativeFrame(
              `editor/${mode}-${index === 1 || (mode === "queued" && long) ? "long-typed-wide" : "literal-typed"}.json`,
            ),
      );
    if (text !== "\r") return;
    if (mode === "modal" && !probe && index++ === 0) {
      await paint(selector(modalLong));
      return;
    }
    acknowledge = () => {
      if (mode === "queued") {
        const native = queued.answers[long ? 1 : 0];
        h.adapter.observe(
          reply(
            native.questionItemId,
            wrong ? "Different native value" : (probe?.text ?? native.answer),
          ),
        );
      } else
        h.observe({
          payload: {
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({
              answers: probe
                ? {
                    literal: {
                      answers: ["None of the above", `user_note: ${wrong ? "Wrong" : probe.text}`],
                    },
                  }
                : wrong
                  ? {
                      ...modal.answers,
                      long: { answers: ["None of the above", "user_note: Wrong"] },
                    }
                  : modal.answers,
            }),
          },
        });
    };
  });
  terminals.push(terminal);
  async function paint(frame: typeof initial) {
    await terminal.writeOutput(
      `\x1b[2J\x1b[H${frame.cursorCellDimmed ? "\x1b[2m" : "\x1b[22m"}${frame.lines.join("\r\n")}\x1b[${frame.cursorY + 1};${frame.cursorX + 1}H\x1b[?25h`,
    );
  }
  await paint(initial);
  const ownership = new PickerInputOwnership(terminal);
  const transaction = new QuestionTransaction(
    h.registry,
    ownership.automated,
    () => ownership.signal(),
    new AbortController().signal,
  );
  function answerText(index: number): string {
    if (mode === "modal") return index === 0 ? values.literal : values.long;
    return long ? values.long : values.literal;
  }
  const pending = transaction.run(
    h.adapter,
    request.id,
    request.questions.map((question, at) => ({
      questionId: question.id,
      text: answerText(at),
    })),
    { timeoutMs: probe?.timeoutMs ?? 3000 },
  );
  const result = pending.then(
    () => "answered",
    () => "failed",
  );
  return { ...h, transaction, result, writes, values, acknowledge: () => acknowledge };
}
