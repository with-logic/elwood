/**
 * Registers and dispatches Codex hook handlers on a session emitter.
 * Implements PRD §5.7, §7A.2 (tool-keyed `PreToolUse` handlers; the `unknown`
 * handler receives only `mcp__*` / `unknown:*` tools), and §7A.3 (an unblocked
 * `Stop` reads the committed turn with a bounded per-pass scan before readiness).
 */

import * as activity from "../../core/activity/index.ts";
import { freezeHookEvent } from "../../core/freeze-hook-event.ts";
import { hookObservationBoundary } from "../../core/hook-observation.ts";
import { isRecord } from "../../core/predicates.ts";
import type { HookErrorEvent } from "../../core/types.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import type { SessionRecord } from "../../state/store.ts";
import { isCodexBlock, requestCodexHook } from "../hooks/dispatch.ts";
import type { CodexHookEvent } from "../hooks/index.ts";
import { serializeCodexHookResult } from "../hooks/serialize.ts";
import { isKnownCommandTool, normalizeCodexHookEvent } from "../hooks/validate.ts";
import type { CodexSessionImpl } from "./instance.ts";
import type {
  CodexEventHandler,
  CodexEventMap,
  CodexEventName,
  StartCodexOptions,
} from "./types.ts";

export function registerInitialHooks(
  emitter: TypedEmitter<CodexEventMap>,
  handlers: StartCodexOptions["hooks"],
): void {
  if (!handlers) return;
  for (const [name, handler] of Object.entries(handlers)) {
    emitter.listen(
      `hook:${name}` as CodexEventName,
      hookHandler(name, handler),
      typeof handler === "function" ? "event" : "tool-keyed",
    );
  }
}

function hookHandler(name: string, handler: unknown): CodexEventHandler<CodexEventName> {
  if (typeof handler === "function") return handler as CodexEventHandler<CodexEventName>;
  if (name !== "PreToolUse" || !isRecord(handler)) return () => undefined;
  return ((event: unknown) => {
    const toolName =
      isRecord(event) && typeof event["tool_name"] === "string" ? event["tool_name"] : "";
    // The `unknown` handler is typed for `mcp__*` / `unknown:*` tools only, so a known
    // command tool with no per-tool handler resolves to no decision rather than being
    // routed into a handler whose parameter type it does not satisfy (§7A.2).
    // Both lookups are OWN-property only, matching Claude routing: a tool named for an
    // inherited member (`toString`, `constructor`, anything on Object.prototype, or a
    // key a caller put on the handler object's prototype) must not reach a handler the
    // caller never registered for it (C-HOOK-19).
    const toolHandler =
      (Object.hasOwn(handler, toolName) ? handler[toolName] : undefined) ??
      (isKnownCommandTool(toolName) || !Object.hasOwn(handler, "unknown")
        ? undefined
        : handler["unknown"]);
    return typeof toolHandler === "function" ? toolHandler(event) : undefined;
  }) as CodexEventHandler<CodexEventName>;
}

export async function dispatchHook(
  input: unknown,
  emitter: TypedEmitter<CodexEventMap>,
  options: StartCodexOptions,
  record: SessionRecord,
  session?: CodexSessionImpl,
) {
  const event = freezeHookEvent(normalizeCodexHookEvent(input as CodexHookEvent));
  const observation = hookObservationBoundary(emitter, record.elwoodSessionId, "codex");
  observation.run("transcript", () => session?.observeTranscript(event.transcript_path));
  if (event.hook_event_name === "SessionStart") {
    session?.rememberCodexSessionId(event.session_id);
    // Codex's authoritative pre-input readiness signal: release the first queued
    // message here, not on the boot-time composer placeholder (C-API-28).
    // The actual ready transition can be deferred by a startup hold; its own
    // boundary retains C-API-42's synchronous fallback and catches rejections.
    session?.markInitialReadyFromHook(observation);
  }
  observation.run("hook", () => emitter.emit("hook", event));
  observation.run("activity", () =>
    emitter.emit("activity", activity.activityFromCodexHook(record.elwoodSessionId, event)),
  );
  const outcome = await requestCodexHook(
    {
      hasListeners: (name) => emitter.hasListeners(name),
      requestWithProvenance: (name, payload) => emitter.requestWithProvenance(name, payload),
      emit: (name, payload) =>
        observation.run(name === "hookError" ? "hook_error" : "activity", () =>
          emitter.emit(name, payload),
        ),
    },
    event,
    options.hookTimeoutMs ?? 25_000,
    record.elwoodSessionId,
  );
  const serialized = serializeCodexHookResult(event.hook_event_name, outcome.result);
  const blocked = isCodexBlock(outcome.result);
  observation.run("activity", () =>
    emitter.emit(
      "activity",
      activity.activityFromHookResult(
        "codex",
        record.elwoodSessionId,
        event.hook_event_name,
        outcome.result,
        outcome.failedOpen,
      ),
    ),
  );
  if (event.hook_event_name === "Stop" && !blocked) {
    // A bounded per-pass scan (like Claude's): the terminal drain budget is reserved
    // for finish(), so hundreds of turns never exhaust it into false backlog drops.
    observation.run("transcript", () => session?.scanTranscript());
    observation.run("lifecycle", () => session?.submitEvidence("hook_turn_ended"));
  }
  observation.report();
  return serialized;
}

/** Contains bridge diagnostics under the same hook notification policy. */
export function buildCodexHookErrorHandler(
  record: SessionRecord,
  emitter: TypedEmitter<CodexEventMap>,
): (event: Omit<HookErrorEvent, "elwoodSessionId">) => void {
  return (event) => {
    const hookError = { elwoodSessionId: record.elwoodSessionId, ...event };
    const observation = hookObservationBoundary(emitter, record.elwoodSessionId, "codex");
    observation.run("hook_error", () => emitter.emit("hookError", hookError));
    observation.run("activity", () =>
      emitter.emit("activity", activity.activityFromHookError("codex", hookError)),
    );
    observation.report();
  };
}
