/** Contains Codex initial-ready Promise observers without hiding synchronous fallback (C-HOOK-22). */
import { hookObservationBoundary } from "../../core/hook-observation.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import type { CodexEventMap } from "./types.ts";

export function observeCodexInitialReady(
  emitter: TypedEmitter<CodexEventMap>,
  elwoodSessionId: string,
  advance: () => void,
): void {
  const observation = hookObservationBoundary(emitter, elwoodSessionId, "codex");
  observation.runRejections("lifecycle", advance);
  observation.report();
}
