/** Codex trust recovery and shutdown integration (C-TRUST-01). */
import { afterEach, vi } from "vitest";
import { startCodex } from "../../src/index.ts";
import { codexComposer } from "../fixtures/trust-composer.ts";
import { trustRecoveryTests } from "../helpers/trust-recovery.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});
trustRecoveryTests({
  agent: "codex",
  start: async () => {
    installFakes();
    const session = await startCodex({ cwd: tempDir(), autotrust: true });
    return { session, pty: ptys.at(-1)! };
  },
  native: "Do you trust the contents of this directory?\n1. Yes, continue\n2. No, quit",
  cursor: "Do you trust the contents of this directory?\n❯ No, quit\n  Yes, continue",
  clear: codexComposer,
});
