/** Preserve agent and lifecycle discriminants in native question envelopes (PRD §5.10). */
import type { ElwoodAgentKind } from "../activity/index.ts";
import type { ElwoodQuestionEvent, ElwoodQuestionRequest } from "./types.ts";

type Lifecycle<Event = ElwoodQuestionEvent> = Event extends ElwoodQuestionEvent
  ? Omit<Event, "agent" | "request">
  : never;
export function requestWithAgent(
  agent: ElwoodAgentKind,
  fields: Omit<ElwoodQuestionRequest, "agent">,
): ElwoodQuestionRequest {
  return agent === "claude"
    ? Object.freeze({ ...fields, agent })
    : Object.freeze({ ...fields, agent });
}
export function eventWithAgent(
  request: ElwoodQuestionRequest,
  fields: Lifecycle,
): ElwoodQuestionEvent {
  return request.agent === "claude"
    ? { ...fields, agent: request.agent, request }
    : { ...fields, agent: request.agent, request };
}
