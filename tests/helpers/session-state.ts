/**
 * State directories laid out as a launch leaves them, for tests that write or resume a
 * session's state. A state write makes at most its file's own directory, inside an existing
 * parent, and never a missing ancestor (PRD §8.1, C-STATE-14), so a test whose writes go below
 * a session's directory needs that directory made first.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeSessionDir, secureMkdir } from "../../src/state/files.ts";
import {
  createSessionRecord,
  prepareStateDir,
  type SessionRecord,
  updateSessionResumeId,
  writeSessionRecord,
} from "../../src/state/store.ts";
import { tempDir } from "./tmp.ts";

/** The CLI a session record belongs to. */
export type SessionAdapter = SessionRecord["adapter"];

/**
 * A prepared state directory, in a project of its own, holding the session directory of
 * `elwoodSessionId`.
 */
export function stateDirWithSession(elwoodSessionId: string, prefix = "elwood-state-"): string {
  const stateDir = tempDir(prefix);
  prepareStateDir(stateDir, { cwd: dirname(stateDir) });
  secureMkdir(safeSessionDir(stateDir, elwoodSessionId));
  return stateDir;
}

/**
 * A state directory holding a resumable record of the `adapter` session `elwoodSessionId`,
 * started in `cwd`.
 */
export function resumableStateDir(
  adapter: SessionAdapter,
  cwd: string,
  elwoodSessionId: string,
): string {
  const stateDir = tempDir("elwood-resume-state-");
  prepareStateDir(stateDir, { cwd: dirname(stateDir) });
  const created = createSessionRecord({ cwd, id: elwoodSessionId, adapter });
  const resumable = updateSessionResumeId(created, adapter, `${adapter}-session-1`);
  writeSessionRecord(resumable, safeSessionDir(stateDir, elwoodSessionId));
  return stateDir;
}

/** A session's record and the names in its session directory, to show a rejection left both. */
export function sessionState(stateDir: string, id: string) {
  const dir = safeSessionDir(stateDir, id);
  return { record: readFileSync(join(dir, "session.json"), "utf8"), entries: readdirSync(dir) };
}
