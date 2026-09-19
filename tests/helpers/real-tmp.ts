/**
 * The OS temp root as it was BEFORE any test redirected `TMPDIR`.
 *
 * `os.tmpdir()` reads `TMPDIR` on every call, and `process.env` is per-PROCESS —
 * Vitest's default `forks` pool reuses one child process for many test files
 * (`isolate` resets the module registry, never the environment). So while a test
 * that redirects `TMPDIR` to its own private dir is running, EVERY other file
 * sharing that fork resolves `os.tmpdir()` to that private dir too; when the
 * redirecting test then `rm -rf`s it, the sibling's scratch directory is deleted
 * out from under a still-running test. That was the rotating one-victim-per-run
 * parallel failure (C-PERF-04, C-ATTN-03, C-CLI-15/25, C-LIFE-10): serial runs
 * passed because nothing else shared the window.
 *
 * Capturing the root at module load — before any test body runs — makes the test
 * helpers' scratch directories immune to the redirect, so they can never land
 * inside (and be destroyed with) another file's private tmp.
 */

import { tmpdir } from "node:os";

/** The real OS temp root, captured before any test can point `TMPDIR` elsewhere. */
export const realTmpRoot: string = tmpdir();
