/** Keep authenticated native Codex rollout metadata separate from core session state (C-STATE-15). */
import { isAbsolute, join } from "node:path";
import { isRecord } from "../core/predicates.ts";
import type { LaunchOwnership } from "./launch-ownership.ts";

type LocatorIO = Pick<LaunchOwnership, "readFile" | "persistFile">;

export function codexRolloutPath(value: unknown): string | undefined {
  return typeof value === "string" &&
    isAbsolute(value) &&
    Buffer.byteLength(value) <= 4_096 &&
    !value.includes("\0")
    ? value
    : undefined;
}

export function loadCodexRollout(
  directory: string,
  nativeSessionId: string,
  read: LocatorIO["readFile"],
) {
  const text = read(join(directory, "codex-rollout.json"));
  if (text === undefined) return undefined;
  try {
    const record: unknown = JSON.parse(text);
    if (!isRecord(record) || record["nativeSessionId"] !== nativeSessionId) return undefined;
    return codexRolloutPath(record["path"]);
  } catch {
    return undefined;
  }
}

export function bindCodexRolloutWriter(directory: string, io: LocatorIO) {
  return (nativeSessionId: string, reportedPath: unknown): void => {
    const path = codexRolloutPath(reportedPath);
    if (path === undefined || loadCodexRollout(directory, nativeSessionId, io.readFile) === path)
      return;
    io.persistFile(
      join(directory, "codex-rollout.json"),
      `${JSON.stringify({ nativeSessionId, path })}\n`,
    );
  };
}
