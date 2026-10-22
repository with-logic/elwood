/** Bind bounded Codex question disablement to public diagnostics (PRD §7A.5). */
import type { QuestionObservationEmitter } from "../../core/questions/observers.ts";
import type { QuestionRegistry } from "../../core/questions/registry.ts";
import { emitSessionWarnings } from "../../core/warnings/session.ts";
import { CodexQuestionAdapter } from "./adapter.ts";

export function codexSessionQuestions(
  registry: QuestionRegistry,
  elwoodSessionId: string,
  emitter: QuestionObservationEmitter,
): CodexQuestionAdapter {
  // Diagnostic listeners are contained without producing another diagnostic.
  const ignoreFailure = () => undefined;
  return new CodexQuestionAdapter(registry, () =>
    emitter.observeErrors(ignoreFailure, () =>
      emitSessionWarnings(
        [
          {
            elwoodSessionId,
            agent: "codex",
            source: "lifecycle",
            code: "question_automation_disabled",
            severity: "warning",
            message:
              "Native question automation exceeded its metadata budget. Use the terminal or start a new session.",
            raw: "",
          },
        ],
        {
          warning: (event) => emitter.emit("warning", event),
          activity: (event) => emitter.emit("activity", event),
        },
      ),
    ),
  );
}
