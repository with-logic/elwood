/** Keep normalized question activity agent, phase and payload correlated (PRD §5.10). */
import type { QuestionActivityEvent } from "./activity.ts";
import type { ElwoodQuestionEvent } from "./types.ts";
export function questionActivity(event: ElwoodQuestionEvent): QuestionActivityEvent {
  const base = {
    elwoodSessionId: event.elwoodSessionId,
    source: "terminal",
    kind: "question",
  } as const;
  if (event.agent === "claude")
    return event.phase === "raised"
      ? Object.freeze({ ...base, agent: event.agent, label: event.phase, question: event })
      : Object.freeze({ ...base, agent: event.agent, label: event.phase, question: event });
  return event.phase === "raised"
    ? Object.freeze({ ...base, agent: event.agent, label: event.phase, question: event })
    : Object.freeze({ ...base, agent: event.agent, label: event.phase, question: event });
}
