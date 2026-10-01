/** Internal Stop callback lifetimes for hook dispatch (PRD §6.3/§7A.4); no admission policy. */
import { AsyncLocalStorage } from "node:async_hooks";
import { ElwoodError } from "./errors.ts";

type StopInputSession = { readonly elwoodSessionId: string };
type StopScope = { readonly hookName: string; readonly session: StopInputSession };
type StopInput = { readonly identity: object; closed: boolean };
const sessionIdentities = new WeakMap<StopInputSession, object>();
const inputContext = new AsyncLocalStorage<StopInput>();

/** Persistent internal work must not inherit a short-lived Stop callback's context. */
export function outsideStopInput<T>(work: () => T): T {
  return inputContext.exit(work);
}

function stopContext(session: StopInputSession): StopInput {
  const identity = sessionIdentities.get(session) ?? {};
  sessionIdentities.set(session, identity);
  return { identity, closed: false };
}

/** Observers, handlers, and reply diagnostics share a lifetime until dispatch settles. */
export async function withStopInput<T>(
  { hookName, session }: StopScope,
  observeAndRequest: () => Promise<T>,
): Promise<T> {
  if (hookName !== "Stop") return observeAndRequest();
  const context = stopContext(session);
  try {
    return await inputContext.run(context, observeAndRequest);
  } finally {
    context.closed = true;
  }
}

/** Malformed recognized Stop diagnostics close at sink return, not socket acknowledgment. */
export function withStopInputNotification<T>({ hookName, session }: StopScope, notify: () => T): T {
  if (hookName !== "Stop") return notify();
  const context = stopContext(session);
  try {
    return inputContext.run(context, notify);
  } finally {
    context.closed = true;
  }
}

/** An opaque token identifies the live instance without retaining its session graph.
 * This is an internal check; dispatch plumbing alone does not enforce public input admission.
 */
export function assertStopInput(session: StopInputSession): void {
  const context = inputContext.getStore();
  if (context && context.identity === sessionIdentities.get(session) && context.closed)
    throw new ElwoodError("wait_timeout", "The Stop input boundary has already completed.");
}
