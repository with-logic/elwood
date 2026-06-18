/**
 * Registers and dispatches Codex hook handlers on a session emitter.
 * Implements PRD §5.7 and §7A.
 */

import * as activity from "../core/activity.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import type { SessionRecord } from "../state/store.ts";
import { isCodexBlock, requestCodexHook } from "./hook-dispatch.ts";
import type { CodexHookEvent } from "./hooks.ts";
import { serializeCodexHookResult } from "./serialize.ts";
import type { CodexSessionImpl } from "./session-instance.ts";
import type {
  CodexEventHandler,
  CodexEventMap,
  CodexEventName,
  StartCodexOptions,
} from "./session-types.ts";
import { normalizeCodexHookEvent } from "./validate.ts";

export function registerInitialHooks(
  emitter: TypedEmitter<CodexEventMap>,
  handlers: StartCodexOptions["hooks"],
): void {
  if (!handlers) return;
  for (const [name, handler] of Object.entries(handlers)) {
    emitter.listen(`hook:${name}` as CodexEventName, handler as CodexEventHandler<CodexEventName>);
  }
}

export async function dispatchHook(
  input: unknown,
  emitter: TypedEmitter<CodexEventMap>,
  options: StartCodexOptions,
  record: SessionRecord,
  session?: CodexSessionImpl,
) {
  const event = normalizeCodexHookEvent(input as CodexHookEvent);
  session?.observeTranscript(event.transcript_path);
  if (event.hook_event_name === "SessionStart") session?.rememberCodexSessionId(event.session_id);
  emitter.emit("hook", event);
  emitter.emit("activity", activity.activityFromHook("codex", record.elwoodSessionId, event));
  const outcome = await requestCodexHook(
    emitter,
    event,
    options.hookTimeoutMs ?? 25_000,
    record.elwoodSessionId,
  );
  emitter.emit(
    "activity",
    activity.activityFromHookResult(
      "codex",
      record.elwoodSessionId,
      event.hook_event_name,
      outcome.result,
      outcome.failedOpen,
    ),
  );
  if (event.hook_event_name === "Stop" && !isCodexBlock(outcome.result)) session?.markReady();
  return serializeCodexHookResult(event.hook_event_name, outcome.result);
}
