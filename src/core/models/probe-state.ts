/**
 * Elwood-owned temp state directory for a session-less probe (C-API-41).
 * The probe creates a fresh directory it fully owns, so it can remove EVERYTHING
 * it allocated — even when adapter startup fails after writing the session
 * directory or runtime files — without touching any caller-owned state.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type OwnedProbeStateDir = {
  /** The fresh, probe-owned state directory to launch the throwaway session in. */
  readonly dir: string;
  /** Removes the owned directory and everything under it; best-effort, never throws. */
  readonly remove: () => void;
};

/**
 * Creates a fresh probe-owned state directory. When the caller supplies a `parent`
 * (the `ListModelsOptions.stateDir`), the temp directory is created inside it so
 * the caller can locate the probe's state; otherwise it lands under the OS temp
 * dir. Either way Elwood OWNS the created directory and removes exactly it — never
 * a caller-owned tree — on cleanup.
 */
export function ownedProbeStateDir(agent: string, parent?: string): OwnedProbeStateDir {
  const root = parent ?? tmpdir();
  // A caller-supplied `stateDir` need not exist yet; mkdtemp requires its parent.
  if (parent !== undefined) mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, `elwood-${agent}-models-`));
  return { dir, remove: () => removeProbeStateDir(dir) };
}

/**
 * Removes a probe-owned directory and everything under it. Best-effort: `force`
 * already ignores an already-gone directory, and any other fs error (EPERM, a
 * file where a directory was expected, and so on) is swallowed so a cleanup
 * failure never masks the probe's real result.
 */
function removeProbeStateDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup: a failure here is never surfaced to the caller.
  }
}
