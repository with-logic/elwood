/** Codex off-allowlist native gates hold queued input without automation (C-TRUST-01). */
import { afterEach, vi } from "vitest";
import { startCodex } from "../../src/index.ts";
import { codexComposer, codexTrust, codexTty } from "../fixtures/trust-composer.ts";
import { unknownGateTests } from "../helpers/unknown-gate.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

unknownGateTests({
  agent: "codex",
  start: async (autotrust) => {
    installFakes();
    const session = await startCodex({ cwd: tempDir(), autotrust });
    return { session, pty: ptys.at(-1)! };
  },
  ready: (session) => becomeReady(session.elwoodSessionId, session.cwd),
  clear: codexComposer,
  renderClear: codexTty,
  known: `${codexTrust}\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue`,
});
