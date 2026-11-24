/** Private Codex rollout sidecars owned by the launch state boundary (PRD §8.2, C-STATE-15). */
import { isAbsolute, join } from "node:path";
import { elwoodError } from "../core/errors.ts";
import { isRecord } from "../core/predicates.ts";
import type { LaunchOwnership, StateFileWriter } from "./launch-ownership.ts";

const maxRolloutPathBytes = 4_096;
const maxLocatorBytes = 32 * 1024;
const locatorFileName = "codex-rollout.json";

export type CodexRolloutLocator = { readonly nativeSessionId: string; readonly path: string };

export function isValidCodexRolloutPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    Buffer.byteLength(value) <= maxRolloutPathBytes &&
    !value.includes("\0")
  );
}

/** Read the bounded launch-owned path for this native conversation. Absence is quiet. */
export function loadCodexRolloutPath(
  sessionDir: string,
  nativeSessionId: string,
  read: LaunchOwnership["readFile"],
): string | undefined {
  try {
    const text = read(join(sessionDir, locatorFileName), maxLocatorBytes);
    if (text === undefined) return undefined;
    const value: unknown = JSON.parse(text);
    if (
      isRecord(value) &&
      value["nativeSessionId"] === nativeSessionId &&
      isValidCodexRolloutPath(value["path"])
    )
      return value["path"];
  } catch {
    // Keep filesystem errors and JSON contents out of optional-resume diagnostics.
  }
  throw invalidLocator();
}

export function writeCodexRolloutLocator(
  sessionDir: string,
  locator: CodexRolloutLocator,
  write: StateFileWriter,
): void {
  const text = `${JSON.stringify(locator)}\n`;
  if (Buffer.byteLength(text) > maxLocatorBytes) throw invalidLocator();
  write(join(sessionDir, locatorFileName), text);
}

function invalidLocator() {
  return elwoodError("state_corrupt", "Invalid private Codex rollout locator.");
}
