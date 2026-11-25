/** Start a hook bridge and preserve its typed failure and cleanup (PRD §6.2, §7A and §9.1). */
import { causeDetails, elwoodError } from "../core/errors.ts";

export async function startHookBridge(
  bridge: { readonly start: () => Promise<void>; readonly stop: () => Promise<void> },
  socketPath: string,
): Promise<void> {
  try {
    await bridge.start();
  } catch (error) {
    await bridge.stop().catch(() => undefined);
    throw elwoodError("hook_bridge_failed", "Could not start Elwood hook bridge.", {
      ...causeDetails(error),
      socketPath,
    });
  }
}
