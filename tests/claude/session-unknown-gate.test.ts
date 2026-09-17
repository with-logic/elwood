/** Claude off-allowlist native gates hold queued input without automation (C-TRUST-01). */
import { afterEach, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import { claudeComposer } from "../fixtures/trust-composer.ts";
import { unknownGateTests } from "../helpers/unknown-gate.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { instructionsLoaded } from "./login-helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

unknownGateTests({
  agent: "claude",
  start: async (autotrust) => {
    installFakes();
    const session = await startClaude({ cwd: tempDir(), autotrust });
    return { session, pty: ptys.at(-1)! };
  },
  ready: (session, pty) =>
    pty.dispatchHook(session.elwoodSessionId, instructionsLoaded(session.cwd)),
  clear: claudeComposer,
});
