/** Claude trust recovery and shutdown integration (C-TRUST-01). */
import { afterEach, vi } from "vitest";

// The driver's own hold-while-blocked loop is covered in its unit suite; this
// captures the guard the session hands it.
let attachGuard: (() => boolean) | undefined;
vi.mock("../../src/claude/attach-images.ts", () => ({
  attachClaudeImages: (
    _terminal: unknown,
    _paths: unknown,
    _signal: unknown,
    blocked: () => boolean,
  ) => {
    attachGuard = blocked;
    return Promise.resolve();
  },
}));
const { startClaude } = await import("../../src/index.ts");

import { claudeComposer } from "../fixtures/trust-composer.ts";
import { trustRecoveryTests } from "../helpers/trust-recovery.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});
trustRecoveryTests({
  agent: "claude",
  start: async () => {
    installFakes();
    const session = await startClaude({ cwd: tempDir(), autotrust: true });
    return { session, pty: ptys.at(-1)! };
  },
  native: "Do you trust this folder?\n1. Yes\n2. No",
  cursor: "Do you trust this folder?\n❯ No, exit\n  Yes, I trust this folder",
  attachGuard: () => attachGuard,
  clear: claudeComposer,
});
