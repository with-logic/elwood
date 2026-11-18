/** Matches a native selector independently of adapter-specific labels (PRD §5.3, C-API-24). */
import type { AgentModelOption } from "./rows.ts";

export function modelTarget(id: string): (option: AgentModelOption) => boolean {
  const wanted = id.toLowerCase();
  return (option) => option.id === wanted;
}
