/** Publish authenticated Codex rollout metadata after launch activation (C-STATE-15). */
import { isAbsolute, join } from "node:path";
import type { CodexRolloutLocatorWriteFailedWarning } from "../../core/warnings/lifecycle.ts";
import type { LaunchOwnership } from "../../state/launch-ownership.ts";
import { codexRolloutLocatorWriteFailedWarning } from "./warnings.ts";

const maxRolloutPathBytes = 4_096;
type RolloutLocator = { readonly nativeSessionId: string; readonly path: string };
type LocatorIO = Pick<LaunchOwnership, "canPersist" | "persistFile">;

function codexRolloutPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    Buffer.byteLength(value) <= maxRolloutPathBytes &&
    !value.includes("\0")
  );
}

export function bindCodexRolloutLocator(
  {
    sessionDir,
    elwoodSessionId,
  }: { readonly sessionDir: string; readonly elwoodSessionId: string },
  io: LocatorIO,
) {
  let active = false;
  let pending: RolloutLocator | undefined;
  const target = join(sessionDir, "codex-rollout.json");

  const write = (locator: RolloutLocator): readonly CodexRolloutLocatorWriteFailedWarning[] => {
    if (!io.canPersist()) return [];
    try {
      io.persistFile(target, `${JSON.stringify(locator)}\n`);
      return [];
    } catch {
      return [codexRolloutLocatorWriteFailedWarning(elwoodSessionId)];
    }
  };

  return {
    observe(nativeSessionId: string, path: unknown) {
      if (!(nativeSessionId && codexRolloutPath(path))) return [];
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
