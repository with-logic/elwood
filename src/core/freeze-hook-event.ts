/** Freeze bridge-owned JSON inputs before observation and dispatch (C-HOOK-22/23). */

/** The bridge has parsed and validated this private JSON tree: no getters or cycles.
 * Traverse iteratively so accepted deeply nested extension fields cannot overflow
 * the JS stack. Allocation remains bounded by the existing request-byte ceiling. */
export function freezeHookEvent<Event extends object>(event: Event): Event {
  const pending: object[] = [event];
  for (const value of pending) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
  }
  return event;
}
