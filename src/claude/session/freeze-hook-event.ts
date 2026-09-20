/** Freeze bridge-owned JSON inputs before observation and dispatch (PRD §6.4, C-HOOK-22). */
import type { ClaudeHookEvent } from "../hooks/index.ts";

/** The bridge has parsed and validated this private JSON tree: no getters or cycles.
 * Traverse iteratively so accepted deeply nested extension fields cannot overflow
 * the JS stack. Allocation remains bounded by the existing request-byte ceiling. */
export function freezeHookEvent(event: ClaudeHookEvent): ClaudeHookEvent {
  const pending: object[] = [event];
  for (const value of pending) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
  }
  return event;
}
