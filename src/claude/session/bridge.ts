/**
 * Claude session hook bridge factory seam.
 * Implements PRD §6.2 and §13.
 */

import { HookBridgeServer } from "../../bridge/server.ts";
import { releasingSocketOnStop } from "../../bridge/socket-release.ts";
import { causeDetails, elwoodError } from "../../core/errors.ts";
import { isClaudeHookInput } from "../validate/input.ts";
import type { HookBridge } from "./cleanup.ts";

export type ClaudeHookBridgeFactory = (
  socketPath: string,
  token: string,
  elwoodSessionId: string,
  dispatch: ConstructorParameters<typeof HookBridgeServer>[2],
  onError: ConstructorParameters<typeof HookBridgeServer>[3],
) => HookBridge;

const realFactory: ClaudeHookBridgeFactory = (socketPath, token, id, dispatch, onError) =>
  new HookBridgeServer(socketPath, token, dispatch, onError, isClaudeHookInput, id);

let factory = realFactory;

/** The configured factory; each bridge it builds releases its socket when it stops. */
export function currentClaudeHookBridgeFactory(): ClaudeHookBridgeFactory {
  return releasingSocketOnStop(factory);
}

export async function startClaudeHookBridge(
  ...options: Parameters<ClaudeHookBridgeFactory>
): Promise<HookBridge> {
  const bridge = currentClaudeHookBridgeFactory()(...options);
  try {
    await bridge.start();
    return bridge;
  } catch (error) {
    await bridge.stop().catch(() => undefined);
    throw elwoodError("hook_bridge_failed", "Could not start Elwood hook bridge.", {
      ...causeDetails(error),
      socketPath: options[0],
    });
  }
}

export function setHookBridgeFactoryForTests(next: ClaudeHookBridgeFactory): void {
  factory = next;
}

export function resetClaudeHookBridgeFactoryForTests(): void {
  factory = realFactory;
}
