/** Bind bounded Codex question disablement to public diagnostics (PRD §7A.5). */
import type { QuestionRegistry } from "../../core/questions/registry.ts";
import type { ElwoodWarningEvent } from "../../core/types.ts";
import { CodexQuestionAdapter } from "./adapter.ts";

export function codexSessionQuestions(
  registry: QuestionRegistry,
  elwoodSessionId: string,
  warn: (warnings: readonly ElwoodWarningEvent[]) => void,
): CodexQuestionAdapter {
  return new CodexQuestionAdapter(registry, () =>
    warn([
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
    ]),
  );
}
