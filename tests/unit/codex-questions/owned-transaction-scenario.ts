/** Set up native metadata, frames, and acceptance for owned-answer proofs (PRD §4). */
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

export type BindingOptions = {
  readonly mode: Mode;
  readonly long: boolean;
  readonly wrong: boolean;
  readonly nativeText?: string;
  readonly probe?: { readonly text: string; readonly timeoutMs?: number };
};
export function unreachableMode(mode: never): never {
  throw new Error(`Unsupported owned-answer mode: ${mode}`);
}
export function setupOwnedScenario(options: BindingOptions) {
  const { mode, long, probe } = options;
  const h = harness();
  const questionCount = probe ? 1 : 2;
  const call = metadata(mode, questionCount);
  h.observe({ payload: call });
  switch (mode) {
    case "queued":
      h.observe({
        payload: {
          type: "AgentMessage",
          id: call.call_id,
          delivery: "async",
          questions: definitions(mode)
            .slice(0, questionCount)
            .map(({ prompt }) => ({ title: prompt })),
        },
      });
      if (long) {
        const first = queuedAcceptance().answers[0];
        h.adapter.observe(reply(first.questionItemId, first.answer));
      }
      break;
    case "modal":
      break;
    default:
      unreachableMode(mode);
  }
  const values = probe ? { literal: probe.text, long: "" } : expected(mode);
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
  const initial = initialFrame(mode, long, literal);
  h.adapter.render(initial);
  return {
    ...h,
    options,
    call,
    values,
    literal,
    modalLong,
    initial,
    request: h.registry.list()[0]!,
  };
}
function initialFrame(mode: Mode, long: boolean, literal: ReturnType<typeof singleEmpty>) {
  switch (mode) {
    case "queued":
      return long ? emptyLong() : literal;
    case "modal":
      return selector(literal);
    default:
      return unreachableMode(mode);
  }
}
export type OwnedScenario = ReturnType<typeof setupOwnedScenario>;
export function typedFrame(scenario: OwnedScenario, index: number) {
  const { mode, long, probe } = scenario.options;
  switch (mode) {
    case "queued":
      return probe
        ? typedChrome(mode, probe.text)
        : nativeFrame(`editor/queued-${long ? "long-typed-wide" : "literal-typed"}.json`);
    case "modal":
      return probe
        ? typedChrome(mode, probe.text)
        : nativeFrame(`editor/modal-${index === 1 ? "long-typed-wide" : "literal-typed"}.json`);
    default:
      return unreachableMode(mode);
  }
}
export function answerText(scenario: OwnedScenario, index: number): string {
  switch (scenario.options.mode) {
    case "queued":
      return scenario.options.long ? scenario.values.long : scenario.values.literal;
    case "modal":
      return index === 0 ? scenario.values.literal : scenario.values.long;
    default:
      return unreachableMode(scenario.options.mode);
  }
}
export function acknowledgeNative(scenario: OwnedScenario): void {
  const { mode, long, wrong, probe, nativeText } = scenario.options;
  switch (mode) {
    case "queued": {
      const native = queuedAcceptance().answers[long ? 1 : 0];
      scenario.adapter.observe(
        reply(
          native.questionItemId,
          nativeText ?? (wrong ? "Different native value" : (probe?.text ?? native.answer)),
        ),
      );
      return;
    }
    case "modal": {
      const captured = modalAcceptance();
      const answers = probe
        ? {
            literal: {
              answers: ["None of the above", `user_note: ${wrong ? "Wrong" : probe.text}`],
            },
          }
        : wrong || nativeText !== undefined
          ? {
              ...captured.answers,
              long: { answers: ["None of the above", `user_note: ${nativeText ?? "Wrong"}`] },
            }
          : captured.answers;
      scenario.observe({
        payload: {
          type: "function_call_output",
          call_id: scenario.call.call_id,
          output: JSON.stringify({ answers }),
        },
      });
      return;
    }
    default:
      unreachableMode(mode);
  }
}
