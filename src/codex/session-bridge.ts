/**
 * Codex session hook bridge factory seam.
 * Implements PRD §7A and §13.
 */

import { HookBridgeServer } from "../bridge/server.ts";
import { resetCodexPreflightCacheForTests } from "./preflight.ts";
import type { CodexHookBridge } from "./session-instance.ts";
import { isCodexHookEvent } from "./validate.ts";

export type CodexHookBridgeFactory = (
  socketPath: string,
  token: string,
  elwoodSessionId: string,
  dispatch: ConstructorParameters<typeof HookBridgeServer>[2],
  onError: ConstructorParameters<typeof HookBridgeServer>[3],
) => CodexHookBridge;

const realFactory: CodexHookBridgeFactory = (socketPath, token, id, dispatch, onError) =>
  new HookBridgeServer(socketPath, token, dispatch, onError, isCodexHookEvent, id);

let factory = realFactory;

export function currentCodexHookBridgeFactory(): CodexHookBridgeFactory {
  return factory;
}

export function setCodexHookBridgeFactoryForTests(next: CodexHookBridgeFactory): void {
  factory = next;
}

export function resetCodexHookBridgeFactoryForTests(): void {
  factory = realFactory;
}

export function resetCodexSessionSeamsForTests(): void {
  resetCodexHookBridgeFactoryForTests();
  resetCodexPreflightCacheForTests();
}
