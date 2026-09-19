/**
 * Per-test temporary directories with automatic cleanup. Every `tempDir()` call
 * registers removal for when the calling test finishes (pass or fail), so a run
 * leaves nothing under the OS temp dir. Shared by the unit and conformance suites.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { realTmpRoot } from "./real-tmp.ts";

/**
 * A fresh directory under the OS temp dir, removed (recursively) after the test.
 * Rooted at the temp dir as it was before any test redirected `TMPDIR`, so a
 * sibling file's private-tmp window can never capture — and then delete — it.
 */
export function tempDir(prefix = "elwood-"): string {
  const path = mkdtempSync(join(realTmpRoot, prefix));
  onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
