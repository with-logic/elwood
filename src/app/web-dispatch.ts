/**
 * Client-message dispatch for the browser dev app.
 * Implements PRD §11.
 *
 * Every session-mutating message runs through the shared WebSessionSlot so
 * concurrent frames serialize instead of racing the module-global session. The
 * dispatch is explicit per known type — there is NO catch-all branch, so an
 * unknown or malformed frame is rejected by the parser and reported as a runtime
 * error rather than silently tearing the session down (teardown is its own type).
 */

import {
  type AgentKind,
  createLiveHookHandlers,
  parseAgentKind,
  type SharedSession,
  type startAgentSession,
} from "./agent-runtime.ts";
import * as events from "./web-events.ts";
import {
  type ClientMessage,
  parseClientMessage,
  type ServerMessage,
  sizeFrom,
} from "./web-messages.ts";
import type { WebSessionSlot } from "./web-session-slot.ts";

export type DispatchDeps = {
  readonly slot: WebSessionSlot;
  readonly broadcast: (message: ServerMessage) => void;
  readonly startSession: typeof startAgentSession;
};

/** Parse, validate, and dispatch one raw frame; report failures to `report`. */
export async function dispatchClientMessage(
  deps: DispatchDeps,
  raw: string,
  report: (message: ServerMessage) => void,
): Promise<void> {
  try {
    await route(deps, parseClientMessage(raw));
  } catch (error) {
    report({
      type: "event",
      entry: events.runtimeErrorEvent(errorMessage(error), errorPayload(error)),
    });
  }
}

function route(deps: DispatchDeps, message: ClientMessage): Promise<void> {
  switch (message.type) {
    case "start":
      return deps.slot.run(() => startOrResume(deps, message));
    // Data-plane ops: resolve the active session UNDER the slot lock, then release it
    // and await the (possibly slow) I/O on that session — it has its own control queue,
    // so holding the slot mutex through a slow paste/resize would head-of-line block
    // every later frame (including the sendKeys escape hatch). See onActiveSession.
    case "prompt":
      return onActiveSession(deps, (session) => session.sendPrompt(message.value));
    case "keys":
      return onActiveSession(deps, (session) => session.sendKeys(message.value));
    case "resize":
      return onActiveSession(deps, (session) => session.resize(sizeFrom(message)));
    case "stop":
    case "kill":
      return deps.slot.run((slot) => closeActive(slot, message.type));
    case "teardown":
      return deps.slot.run((slot) => teardownActive(slot));
  }
}

/** Snapshot the active session under the slot lock, release it, then run `work`. */
async function onActiveSession(
  deps: DispatchDeps,
  work: (session: SharedSession) => Promise<void>,
): Promise<void> {
  const session = await deps.slot.run(async (slot) => slot.require());
  await work(session);
}

async function startOrResume(
  deps: DispatchDeps,
  message: Extract<ClientMessage, { readonly type: "start" }>,
): Promise<void> {
  const agent = parseAgentKind(message.agent);
  const session = await deps.startSession({
    agent,
    cwd: message.cwd,
    size: sizeFrom(message),
    hooks: loggingHooks(agent),
    ...(message.stateDir === undefined ? {} : { stateDir: message.stateDir }),
    ...(message.elwoodSessionId === undefined ? {} : { elwoodSessionId: message.elwoodSessionId }),
  });
  await deps.slot.replace(session);
  wireSession(deps, session);
  announceSession(deps, session);
}

function announceSession(deps: DispatchDeps, session: SharedSession): void {
  const summary = { id: session.elwoodSessionId, cwd: session.cwd, status: session.status };
  deps.broadcast({ type: "session", ...summary });
  deps.broadcast({ type: "event", entry: events.sessionEvent(summary) });
}

async function closeActive(slot: WebSessionSlot, action: "stop" | "kill"): Promise<void> {
  const active = slot.require();
  await active[action]();
  slot.clearIf(active);
}

async function teardownActive(slot: WebSessionSlot): Promise<void> {
  const active = slot.require();
  await active.teardown();
  slot.clearIf(active);
}

function wireSession(deps: DispatchDeps, active: SharedSession): void {
  const emit = (entry: ReturnType<typeof events.sessionEvent>) =>
    deps.broadcast({ type: "event", entry });
  active.on("terminal:data", (event) => deps.broadcast({ type: "terminal", data: event.data }));
  active.on("terminal:exit", (event) => emit(events.terminalExitEvent(event)));
  active.on("status", (event) => {
    deps.broadcast({ type: "status", status: event.status });
    emit(events.statusEvent(event, active.statusDecisions().at(-1)));
  });
  active.on("activity", (event) => emit(events.activityEvent(event)));
  active.on("warning", (event) => emit(events.warningEvent(event)));
  active.on("hook", (event) => emit(events.hookEvent(event)));
  active.on("hookError", (event) => emit(events.hookErrorEvent(event)));
}

function loggingHooks(agent: AgentKind) {
  return createLiveHookHandlers(agent, { write: () => undefined });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorPayload(error: unknown): Readonly<Record<string, unknown>> {
  if (!(error instanceof Error)) return { value: String(error) };
  return { name: error.name, message: error.message, stack: error.stack };
}
