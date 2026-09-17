/** Codex trust recovery and shutdown integration (C-TRUST-01). */
import { afterEach, vi } from "vitest";

// The driver's own hold-while-blocked loop is covered in its unit suite; this
// captures the guard the session hands it.
let attachGuard: (() => boolean) | undefined;
vi.mock("../../src/codex/images/attach.ts", () => ({
  attachCodexImages: (
    _terminal: unknown,
    _paths: unknown,
    _signal: unknown,
    blocked: () => boolean,
  ) => {
    attachGuard = blocked;
    return Promise.resolve();
  },
}));
const { startCodex } = await import("../../src/index.ts");

import { codexComposer, codexTrust } from "../fixtures/trust-composer.ts";
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
  native: `${codexTrust}\n1. Yes, continue\n2. No, quit`,
  cursor: `${codexTrust}\n❯ No, quit\n  Yes, continue`,
  attachGuard: () => attachGuard,
  clear: codexComposer,
});
