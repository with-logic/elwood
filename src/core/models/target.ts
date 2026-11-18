/** Matches launch selectors and Claude's legacy custom-label switches (PRD §5.3, C-API-24). */
import type { ElwoodAgentKind } from "../activity/index.ts";
import { claudeModelSelector } from "./claude-selector.ts";
import type { AgentModelOption } from "./rows.ts";

export function modelTarget(
  agent: ElwoodAgentKind,
  id: string,
): (option: AgentModelOption) => boolean {
  const label = id.toLowerCase();
  const wanted = (agent === "claude" ? claudeModelSelector(id) : null) ?? label;
  return (option) =>
    option.id === wanted ||
    (agent === "claude" && option.id === null && option.label.toLowerCase() === label);
}
