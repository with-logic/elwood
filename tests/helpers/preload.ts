/**
 * Shared Vitest preload (`setupFiles`): resets the runtime test seams — command
 * runner, PTY factory, platform, and probe timeout — after EVERY test, so a suite
 * that installs a fake can never leak it into a later test, even when it fails
 * before reaching its own reset.
 */

import { afterEach } from "vitest";
import { resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";

afterEach(() => {
  resetRuntimeSeamsForTests();
});
