/** Probe-output setup failures are startup failures, not missing CLIs (PRD §9.2, C-ERR-08). */

/** Recognizes structured command errors and thrown errors carrying setup provenance. */
export function isProbeSetupError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "origin" in error &&
    error.origin === "probe_setup"
  );
}
