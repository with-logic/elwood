/** Read and publish authenticated Codex rollout metadata (PRD §8.2, C-STATE-15). */
import { isAbsolute, join } from "node:path";
import { isRecord } from "../../core/predicates.ts";
import type { CodexRolloutLocatorWriteFailedWarning } from "../../core/warnings/lifecycle.ts";
import { assertStatePath } from "../../state/directories.ts";
import type { LaunchOwnership } from "../../state/launch-ownership.ts";
import { currentFileOwner, readPrivateFile } from "../../state/private-read.ts";
import { codexRolloutLocatorWriteFailedWarning } from "./warnings.ts";

const maxRolloutPathBytes = 4_096;
const maxLocatorBytes = 32 * 1024;
const locatorFileName = "codex-rollout.json";
type RolloutLocator = { readonly nativeSessionId: string; readonly path: string };
type LocatorIO = Pick<LaunchOwnership, "canPersist" | "persistFile">;

function isValidCodexRolloutPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    Buffer.byteLength(value) <= maxRolloutPathBytes &&
    !value.includes("\0")
  );
}

/** Return the private saved locator only when it names this native conversation. */
export function loadCodexRolloutLocator(
  sessionDir: string,
  nativeSessionId: string,
): string | undefined {
  const target = join(sessionDir, locatorFileName);
  try {
    assertStatePath(target);
    const text = readPrivateFile(
      target,
      currentFileOwner(),
      () => new Error("Invalid private Codex rollout locator."),
      maxLocatorBytes,
    );
    if (text === undefined) return undefined;
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || value["nativeSessionId"] !== nativeSessionId) return undefined;
    const path = value["path"];
    return isValidCodexRolloutPath(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

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
  let pending: RolloutLocator | undefined;
  const target = join(sessionDir, locatorFileName);

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
