/** Real-terminal harness for private question session controllers (PRD §4). */
import { vi } from "vitest";
import type { ElwoodActivityEvent } from "../../../src/core/activity/index.ts";
import type { QuestionActivityEvent } from "../../../src/core/questions/activity.ts";
import type { QuestionAdapter } from "../../../src/core/questions/adapter.ts";
import { SessionQuestions } from "../../../src/core/questions/controller.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import type { ElwoodCommonEventMap } from "../../../src/core/types.ts";
import { TypedEmitter } from "../../../src/events/emitter.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";

type Events = Omit<ElwoodCommonEventMap, "activity"> & {
  activity: ElwoodActivityEvent | QuestionActivityEvent;
  question: ElwoodQuestionEvent;
};
const terminals: ReturnType<typeof createHeadlessTerminal>[] = [];
export function disposeControllers(): void {
  for (const terminal of terminals.splice(0)) terminal.dispose();
}
export function controllerHarness(closing = new AbortController()) {
  const terminal = createHeadlessTerminal({ cols: 140, rows: 45 }, () => {});
  terminals.push(terminal);
  const events = new TypedEmitter<Events>();
  const questions = new SessionQuestions(
    "claude",
    "s",
    events,
    terminal,
    () => new AbortController().signal,
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
  return { terminal, events, questions, closing, adapter, activity };
}
