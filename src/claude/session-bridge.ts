/**
 * Claude session hook bridge factory seam.
 * Implements PRD §6.2 and §13.
 */

import { HookBridgeServer } from "../bridge/server.ts";
import type { HookBridge } from "./session-instance.ts";

export type ClaudeHookBridgeFactory = (
  socketPath: string,
  token: string,
  elwoodSessionId: string,
  dispatch: ConstructorParameters<typeof HookBridgeServer>[2],
  onError: ConstructorParameters<typeof HookBridgeServer>[3],
) => HookBridge;

const realFactory: ClaudeHookBridgeFactory = (socketPath, token, id, dispatch, onError) =>
  new HookBridgeServer(socketPath, token, dispatch, onError, undefined, id);

let factory = realFactory;

export function currentClaudeHookBridgeFactory(): ClaudeHookBridgeFactory {
  return factory;
}

export function setHookBridgeFactoryForTests(next: ClaudeHookBridgeFactory): void {
  factory = next;
}

export function resetClaudeHookBridgeFactoryForTests(): void {
  factory = realFactory;
}
