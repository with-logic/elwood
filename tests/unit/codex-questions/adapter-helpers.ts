/** Real private Codex registry and lifecycle harness (PRD §4). */
import { CodexQuestionAdapter } from "../../../src/codex/questions/adapter.ts";
import type { ElwoodActivityEvent } from "../../../src/core/activity/index.ts";
import type { QuestionActivityEvent } from "../../../src/core/questions/activity.ts";
import { QuestionRegistry } from "../../../src/core/questions/registry.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { TypedEmitter } from "../../../src/events/emitter.ts";
import { event } from "./helpers.ts";

type QuestionEventMap = {
  question: ElwoodQuestionEvent;
  activity: ElwoodActivityEvent | QuestionActivityEvent;
};
export function harness(onDisabled?: () => void) {
  const events: ElwoodQuestionEvent[] = [];
  const emitter = new TypedEmitter<QuestionEventMap>();
  emitter.on("question", (question) => events.push(question));
  const registry = new QuestionRegistry("codex", "test", emitter);
  const adapter = new CodexQuestionAdapter(registry, onDisabled);
  const observe = (raw: unknown) => adapter.observe(event(raw));
  return { events, emitter, registry, adapter, observe };
}
