/** Content-free live question diagnostics (PRD §5.4 and §5.10). */
import type { ElwoodAgentKind } from "../activity/index.ts";

export type QuestionAutomationDisabledWarning = {
  readonly elwoodSessionId: string;
  readonly agent: "codex";
  readonly source: "lifecycle";
  readonly code: "question_automation_disabled";
  readonly severity: "warning";
  readonly message: string;
  readonly raw: string;
};

export type QuestionObserverFailurePhase = "question" | "activity";

export type QuestionObserverFailedWarning = {
  readonly elwoodSessionId: string;
  readonly agent: ElwoodAgentKind;
  readonly source: "lifecycle";
  readonly code: "question_observer_failed";
  readonly severity: "warning";
  readonly message: "A question notification failed; native question ownership was preserved.";
  readonly phase: QuestionObserverFailurePhase;
  readonly raw: `question_observer_failed phase=${QuestionObserverFailurePhase}`;
};
