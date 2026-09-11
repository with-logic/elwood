/**
 * Enumerates CLI-owned session records with timestamps and a socket-presence
 * liveness signal, skipping (never failing on) unreadable records.
 * Implements PRD §12A.8 and C-CLI-22.
 */

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { elwoodError, errnoCode, toError } from "../../core/errors.ts";
import { readPrivateSessionRecord } from "../../state/private-session.ts";
import { sessionSocketHome } from "../../state/socket-home.ts";
import type { SessionRecord } from "../../state/store.ts";
import type { CliAgent } from "../types.ts";

export type CliSessionListing = {
  readonly id: string;
  readonly agent: CliAgent;
  readonly cwd: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly resumable: boolean;
  readonly live: boolean;
};

export type SkippedSession = { readonly id: string; readonly message: string };

export type SessionListResult = {
  readonly sessions: readonly CliSessionListing[];
  readonly skipped: readonly SkippedSession[];
};

export type ReadSessionRecord = (stateDir: string, id: string) => SessionRecord;

/** List every session directory under `<stateDir>/sessions`, most recently used first. */
export function listCliSessions(
  stateDir: string,
  readRecord: ReadSessionRecord = readPrivateSessionRecord,
): SessionListResult {
  const root = resolve(stateDir);
  const sessions: CliSessionListing[] = [];
  const skipped: SkippedSession[] = [];
  for (const id of sessionDirectoryNames(join(root, "sessions"))) {
    try {
      sessions.push(listing(root, id, readRecord(root, id)));
    } catch (error) {
      skipped.push({ id, message: toError(error).message });
    }
  }
  sessions.sort(
    (left, right) =>
      right.lastUsedAt.localeCompare(left.lastUsedAt) || left.id.localeCompare(right.id),
  );
  return { sessions, skipped };
}

function sessionDirectoryNames(sessionsDir: string): readonly string[] {
  try {
    return readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw elwoodError("state_corrupt", `Could not read the Elwood state directory ${sessionsDir}`);
  }
}

function listing(root: string, id: string, record: SessionRecord): CliSessionListing {
  const sessionDir = join(root, "sessions", id);
  const directory = statSync(sessionDir);
  const file = statSync(join(sessionDir, "session.json"));
  return {
    id,
    agent: record.adapter,
    cwd: record.cwd,
    createdAt: new Date(directory.birthtimeMs).toISOString(),
    lastUsedAt: new Date(file.mtimeMs).toISOString(),
    resumable: record[record.adapter].resumeId !== undefined,
    live: socketPresent(root, id, record.adapter),
  };
}

/** Cheap, side-effect-free: a launch's bridge socket file exists in the stable home. */
function socketPresent(stateDir: string, elwoodSessionId: string, adapter: CliAgent): boolean {
  try {
    return readdirSync(sessionSocketHome({ stateDir, elwoodSessionId, adapter })).some((name) =>
      name.endsWith(".sock"),
    );
  } catch {
    return false;
  }
}
