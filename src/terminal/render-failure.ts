/**
 * Private notice that a terminal's render failed. The failure is permanent, and the failed
 * write draws no frame, so a judgment waiting on undrawn output judges the last frame
 * instead (PRD §5.3, C-API-28, C-API-56).
 */
import type { XtermTerminal } from "./headless.ts";

const listeners = new WeakMap<XtermTerminal, Set<() => void>>();

/**
 * Terminal wrappers share the xterm identity. Delivered once, in a microtask, so a
 * listener must contain its own failures: one that throws is an uncaught exception.
 */
export function onRenderFailed(xterm: XtermTerminal, listener: () => void): void {
  const subscribed = listeners.get(xterm) ?? new Set();
  subscribed.add(listener);
  listeners.set(xterm, subscribed);
}

/** Let the failing write finish before a listener can judge or write. */
export function reportRenderFailed(xterm: XtermTerminal): void {
  const subscribed = listeners.get(xterm);
  listeners.delete(xterm);
  for (const listener of subscribed ?? []) queueMicrotask(listener);
}
