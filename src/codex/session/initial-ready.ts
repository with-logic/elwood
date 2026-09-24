/** Contains Codex initial-ready Promise observers without hiding synchronous fallback (C-API-42). */
import {
  type HookObservation,
  initialReadyObservationBoundary,
} from "../../core/hook-observation.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import type { CodexEventMap } from "./types.ts";

export function observeCodexInitialReady(
  emitter: TypedEmitter<CodexEventMap>,
  elwoodSessionId: string,
  advance: () => void,
  hookObservation?: HookObservation,
): void {
  const observation = hookObservation ?? initialReadyObservationBoundary(emitter, elwoodSessionId);
  observation.runRejections("lifecycle", advance);
  if (!hookObservation) observation.report();
}
