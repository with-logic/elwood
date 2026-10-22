/** Real-terminal harness for private question session controllers (PRD §4). */
import { vi } from "vitest";
import type { ElwoodActivityEvent } from "../../../src/core/activity/index.ts";
import type { QuestionActivityEvent } from "../../../src/core/questions/activity.ts";
import type { QuestionAdapter, QuestionFrame } from "../../../src/core/questions/adapter.ts";
import { SessionQuestions } from "../../../src/core/questions/controller.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import type { ElwoodCommonEventMap } from "../../../src/core/types.ts";
import { TypedEmitter } from "../../../src/events/emitter.ts";
import { createHeadlessTerminal, type ElwoodTerminal } from "../../../src/terminal/headless.ts";

type Events = Omit<ElwoodCommonEventMap, "activity"> & {
  activity: ElwoodActivityEvent | QuestionActivityEvent;
  question: ElwoodQuestionEvent;
};
const terminals: ReturnType<typeof createHeadlessTerminal>[] = [];
export function disposeTerminals(): void {
  for (const terminal of terminals.splice(0)) terminal.dispose();
}
type ControllerHarnessOptions = {
  readonly closing?: AbortController;
  readonly input?: AbortController;
  readonly onInput?: (data: string | Uint8Array) => void;
};
export function controllerHarness({
  closing = new AbortController(),
  input = new AbortController(),
  onInput,
}: ControllerHarnessOptions = {}) {
  const writes: (string | Uint8Array)[] = [];
  const terminal = createHeadlessTerminal({ cols: 140, rows: 45 }, (data) => {
    writes.push(data);
    onInput?.(data);
  });
  terminals.push(terminal);
  const events = new TypedEmitter<Events>();
  const questions = new SessionQuestions(
    "claude",
    "s",
    events,
    terminal,
    () => input.signal,
    closing.signal,
  );
  const adapter: QuestionAdapter = {
    observe: vi.fn(() => false),
    render: vi.fn(),
    blocksInput: () => false,
    answer: async () => {},
  };
  const activity = (label = "changed") =>
    events.emit("activity", {
      elwoodSessionId: "s",
      agent: "claude",
      source: "hook",
      kind: "hook",
      label,
    });
  return { terminal, events, questions, closing, input, writes, adapter, activity };
}

/** Paint viewport coordinates while preserving captured cursor visibility when known. */
export function paintQuestionFrame(terminal: ElwoodTerminal, frame: QuestionFrame): Promise<void> {
  const visibility =
    frame.cursorVisible === undefined ? "" : frame.cursorVisible ? "\x1b[?25h" : "\x1b[?25l";
  return terminal.writeOutput(
    `\x1b[H\x1b[2J${frame.lines.join("\r\n")}\x1b[${frame.cursorRow + 1};${frame.cursorX + 1}H${visibility}`,
  );
}
