/**
 * Per-test temporary directories with automatic cleanup. Every `tempDir()` call
 * registers removal for when the calling test finishes (pass or fail), so a run
 * leaves nothing under the OS temp dir. Shared by the unit and conformance suites.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

/** A fresh directory under the OS temp dir, removed (recursively) after the test. */
export function tempDir(prefix = "elwood-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
