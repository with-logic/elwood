/** Expire Stop callback input admission when its response finalizes (PRD §6.3/§7A.2). */
import { AsyncLocalStorage } from "node:async_hooks";
import { ElwoodError } from "./errors.ts";

type StopInputSession = { readonly elwoodSessionId: string };
type StopInput = { readonly session: StopInputSession; closed: boolean };
const inputContext = new AsyncLocalStorage<StopInput>();

/** Persistent internal work must not inherit a short-lived Stop callback's authority. */
export function outsideStopInput<T>(work: () => T): T {
  return inputContext.exit(work);
}

/** Observers, handlers, and reply diagnostics share one lifetime until the reply settles. */
export async function withStopInput<T>(
  { hookName, session }: { readonly hookName: string; readonly session: StopInputSession },
  observeAndRequest: () => Promise<T>,
): Promise<T> {
  if (hookName !== "Stop") return observeAndRequest();
  const context: StopInput = { session, closed: false };
  try {
    return await inputContext.run(context, observeAndRequest);
  } finally {
    context.closed = true;
  }
}

/** The live session object is the full identity, even if another state directory reuses its ID. */
export function assertStopInput(session: StopInputSession): void {
  const context = inputContext.getStore();
  if (context?.session === session && context.closed)
    throw new ElwoodError("wait_timeout", "The Stop input boundary has already completed.");
}

/** Check admission, then detach internal queue work from the caller's async context. */
export function admitHookInput<T>(session: StopInputSession, enqueue: () => T): T {
  assertStopInput(session);
  return inputContext.exit(enqueue);
}
