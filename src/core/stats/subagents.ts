/** Subagent lifecycle observations from validated hook decisions (PRD §5.12, C-STATS-02). */
import type { ClaudeHookEvent } from "../../claude/hooks/index.ts";
import type { CodexHookEvent } from "../../codex/hooks/index.ts";
import type { SubagentObservation } from "./types.ts";

export function subagentObservation(
  event: ClaudeHookEvent | CodexHookEvent,
  blocked: boolean,
  closing: AbortSignal | undefined,
): SubagentObservation | undefined {
  const name = event.hook_event_name;
  if (name !== "SubagentStart" && (name !== "SubagentStop" || blocked)) return undefined;
  if (closing?.aborted || event.agent_id.trim() === "") return undefined;
  return {
    id: event.agent_id,
    type: event.agent_type,
    state: name === "SubagentStart" ? "started" : "stopped",
  };
}
