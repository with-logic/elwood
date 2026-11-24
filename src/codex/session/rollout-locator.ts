/** Buffer authenticated Codex rollout metadata until launch commit (PRD §8.2, C-STATE-15). */
import type { CodexRolloutLocatorWriteFailedWarning } from "../../core/warnings/lifecycle.ts";
import {
  type CodexRolloutLocator,
  isValidCodexRolloutPath,
  writeCodexRolloutLocator,
} from "../../state/codex-rollout.ts";
import type { LaunchOwnership } from "../../state/launch-ownership.ts";
import { codexRolloutLocatorWriteFailedWarning } from "./warnings.ts";

type LocatorIO = Pick<LaunchOwnership, "canPersist" | "persistFile">;

/**
 * Accept reports the caller matched to the current native session ID. Keep the latest valid
 * report until launch commit, then write it and any later reports, warning on write failure.
 */
export function bindCodexRolloutLocator(
  {
    sessionDir,
    elwoodSessionId,
  }: { readonly sessionDir: string; readonly elwoodSessionId: string },
  io: LocatorIO,
) {
  let active = false;
  let pending: CodexRolloutLocator | undefined;

  const write = (
    locator: CodexRolloutLocator,
  ): readonly CodexRolloutLocatorWriteFailedWarning[] => {
    if (!io.canPersist()) return [];
    try {
      writeCodexRolloutLocator(sessionDir, locator, io.persistFile);
      return [];
    } catch {
      return [codexRolloutLocatorWriteFailedWarning(elwoodSessionId)];
    }
  };

  return {
    observe(nativeSessionId: string, path: unknown) {
      if (!(nativeSessionId && isValidCodexRolloutPath(path))) return [];
      const locator = { nativeSessionId, path };
      if (active) return write(locator);
      pending = locator;
      return [];
    },
    onLaunchCommitted() {
      active = true;
      const locator = pending;
      pending = undefined;
      return locator === undefined ? [] : write(locator);
    },
  };
}
