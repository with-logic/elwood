/** Expire Stop callback input admission when its response finalizes (PRD §6.3/§7A.2). */
import { AsyncLocalStorage } from "node:async_hooks";
import { ElwoodError } from "./errors.ts";

type StopInput = { readonly sessionId: string; closed: boolean };
const inputContext = new AsyncLocalStorage<StopInput>();

/** Observers and registered handlers share a lifetime; readiness runs after it closes. */
export async function withStopInput<T>(
  hookName: string,
  sessionId: string,
  observeAndRequest: () => Promise<T>,
): Promise<T> {
  if (hookName !== "Stop") return observeAndRequest();
  const context: StopInput = { sessionId, closed: false };
  try {
    return await inputContext.run(context, observeAndRequest);
  } finally {
    context.closed = true;
  }
}

/** Check admission, then detach internal queue work from the caller's async context. */
export function admitHookInput<T>(sessionId: string, enqueue: () => T): T {
  const context = inputContext.getStore();
  if (context?.sessionId === sessionId && context.closed)
    throw new ElwoodError("wait_timeout", "The Stop input boundary has already completed.");
  return inputContext.exit(enqueue);
}
