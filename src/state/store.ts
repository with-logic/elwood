/**
 * Project-local Elwood session metadata persistence.
 * Implements PRD §8: the record persists ONLY what resume genuinely needs (adapter,
 * cwd, per-adapter resumeId + launch posture). Paths, bridge token, socket home,
 * terminal size, status, warnings, metadata, and timestamps are NOT persisted — they
 * are recomputed at each launch and live in memory only.
 */

import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { elwoodError, toError } from "../core/errors.ts";
import { assertStatePath } from "./directories.ts";
import {
  safeSessionDir,
  secureMkdir,
  sharedMkdir,
  writePrivateFileAtomic,
  writeSharedFile,
} from "./files.ts";
import type { AdapterState, ClaudeLaunchPosture, CodexLaunchPosture } from "./launch-posture.ts";
import { currentFileOwner, type FileOwner, readPrivateFile } from "./private-read.ts";
import { removeSocketHome } from "./socket-home.ts";
import { validateSessionRecord } from "./validate.ts";

export type SessionRecord = {
  readonly schemaVersion: 1;
  readonly elwoodSessionId: string;
  readonly adapter: "claude" | "codex";
  readonly cwd: string;
  readonly claude: AdapterState<ClaudeLaunchPosture>;
  readonly codex: AdapterState<CodexLaunchPosture>;
};

export function defaultStateDir(cwd: string): string {
  return join(resolve(cwd), ".elwood");
}

export { safeSessionDir as sessionDir };

export function createSessionRecord(input: {
  readonly cwd: string;
  readonly id: string;
  readonly adapter?: "claude" | "codex";
}): SessionRecord {
  const adapter = input.adapter ?? "claude";
  return {
    schemaVersion: 1,
    elwoodSessionId: input.id,
    adapter,
    cwd: resolve(input.cwd),
    claude: {},
    codex: {},
  };
}

export function prepareStateDir(
  stateDir: string,
  options: { readonly gitignore?: boolean } = {},
): void {
  const root = resolve(stateDir);
  assertStatePath(root);
  assertStatePath(join(root, "sessions"));
  if (options.gitignore === true) {
    sharedMkdir(root);
  } else {
    secureMkdir(root);
  }
  const gitignorePath = join(root, ".gitignore");
  if (options.gitignore === true && !existsSync(gitignorePath)) {
    writeSharedFile(gitignorePath, "*\n");
  }
  secureMkdir(join(root, "sessions"));
}

/** Persist the record into its derived session directory (not stored on the record). */
export function writeSessionRecord(
  record: SessionRecord,
  sessionDir: string,
  write: (path: string, text: string) => void = writePrivateFileAtomic,
): void {
  write(recordPath(sessionDir), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Read a session record without following symlinks and only when it is a private
 * regular file owned by `owner` (§8.2): a planted link or a shared/foreign-owned
 * record is `state_corrupt`, never trusted for resume. Absence is `state_not_found`.
 */
export function readSessionRecord(
  stateDir: string,
  id: string,
  owner: FileOwner | undefined = currentFileOwner(),
): SessionRecord {
  const corrupt = (cause: string) =>
    elwoodError("state_corrupt", `Session state is corrupt for ${id}`, { cause });
  const text = readPrivateFile(recordPath(safeSessionDir(stateDir, id)), owner, corrupt);
  if (text === undefined) throw elwoodError("state_not_found", `No Elwood session found for ${id}`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw corrupt(toError(error).message);
  }
  const parsed = validateSessionRecord(raw, id);
  if (!parsed) throw elwoodError("state_corrupt", `Session state is invalid for ${id}`);
  return parsed;
}

export function updateSessionResumeId(
  record: SessionRecord,
  adapter: "claude" | "codex",
  resumeId: string,
): SessionRecord {
  return { ...record, [adapter]: { ...record[adapter], resumeId } };
}

/** The identifying inputs for removing a session's derived files and socket home. */
export type RemoveSessionFilesInput = {
  readonly stateDir: string;
  readonly elwoodSessionId: string;
  /** The session's stable socket home directory (§8.1), removed whole. */
  readonly socketHome: string;
};

/** Remove a session's derived directory AND its whole stable socket home (§8.1). */
export function removeSessionFiles(input: RemoveSessionFilesInput): void {
  const dir = safeSessionDir(input.stateDir, input.elwoodSessionId);
  // Attempt BOTH removals independently (§8.4 attempt-all): a socket-home removal
  // failure must NOT prevent the session-directory removal that leaves resumable
  // metadata + runtime files behind. Collect the first failure and report it after
  // both ran, so teardown removes everything it can and still surfaces the fault.
  let firstError: unknown;
  firstError = tryRemove(() => removeSocketHome(input.socketHome), firstError);
  firstError = tryRemove(() => {
    assertStatePath(dir);
    rmSync(dir, { recursive: true, force: true });
  }, firstError);
  if (firstError !== undefined) {
    throw elwoodError("teardown_failed", "Could not remove Elwood session files.", {
      cause: firstError instanceof Error ? firstError.message : String(firstError),
      sessionDir: dir,
    });
  }
}

/** Run a removal step, keeping the FIRST error so every step is still attempted. */
function tryRemove(step: () => void, prior: unknown): unknown {
  try {
    step();
    return prior;
  } catch (error) {
    return prior ?? error;
  }
}

function recordPath(dir: string): string {
  return join(dir, "session.json");
}
