/**
 * Real private state-directory fixtures shared by the session-listing tests.
 */

import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secureMkdir } from "../../src/state/files.ts";
import { ensurePrivateStateRoot } from "../../src/state/private-session.ts";
import {
  createSessionRecord,
  sessionDir,
  updateSessionResumeId,
  writeSessionRecord,
} from "../../src/state/store.ts";

export const roots: string[] = [];
export const socketHomes: string[] = [];

/** Remove every planted state root and socket home; register with `afterEach`. */
export function cleanupSessionFixtures(): void {
  for (const home of socketHomes.splice(0)) rmSync(home, { recursive: true, force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "elwood-sessions-"));
  roots.push(root);
  const stateDir = join(root, "state");
  ensurePrivateStateRoot(stateDir);
  return stateDir;
}

export function plant(
  stateDir: string,
  id: string,
  adapter: "claude" | "codex",
  options: { readonly resumeId?: string; readonly lastUsed?: number } = {},
): string {
  const dir = sessionDir(stateDir, id);
  secureMkdir(dir);
  const created = createSessionRecord({ cwd: tmpdir(), id, adapter });
  const record =
    options.resumeId === undefined
      ? created
      : updateSessionResumeId(created, adapter, options.resumeId);
  writeSessionRecord(record, dir);
  if (options.lastUsed !== undefined) {
    const seconds = options.lastUsed / 1000;
    utimesSync(join(dir, "session.json"), seconds, seconds);
  }
  return dir;
}
