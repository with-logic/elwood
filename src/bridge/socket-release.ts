/**
 * Releases a launch's socket when its hook bridge stops (PRD §8.1): the bridge unlinks
 * its socket file, and the session's socket home goes too once no other launch's socket
 * is in it. Wraps each adapter's bridge factory seam, so every bridge a launch builds,
 * including a test's, releases its socket on `stop`, `kill`, the agent exiting, and a
 * failed start.
 */

import { releaseLaunchSocket } from "../state/socket-home.ts";

type Bridge = { readonly start: () => Promise<void>; readonly stop: () => Promise<void> };

/** `factory`, with each bridge's successful `stop()` followed by its socket's release. */
export function releasingSocketOnStop<Rest extends readonly unknown[]>(
  factory: (socketPath: string, ...rest: Rest) => Bridge,
): (socketPath: string, ...rest: Rest) => Bridge {
  return (socketPath, ...rest) => {
    const bridge = factory(socketPath, ...rest);
    return {
      start: () => bridge.start(),
      stop: async () => {
        await bridge.stop();
        releaseLaunchSocket(socketPath);
      },
    };
  };
}
