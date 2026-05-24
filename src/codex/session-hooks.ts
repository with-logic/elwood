/**
 * Registers launch-time Codex hook handlers on a session emitter.
 * Implements PRD §5.7 and §7A.
 */

import type { TypedEmitter } from "../events/emitter.ts";
import type {
  CodexEventHandler,
  CodexEventMap,
  CodexEventName,
  StartCodexOptions,
} from "./session-types.ts";

export function registerInitialHooks(
  emitter: TypedEmitter<CodexEventMap>,
  handlers: StartCodexOptions["hooks"],
): void {
  if (!handlers) return;
  for (const [name, handler] of Object.entries(handlers)) {
    emitter.listen(`hook:${name}` as CodexEventName, handler as CodexEventHandler<CodexEventName>);
  }
}
