/**
 * A named Claude session (`name`, as Coal Harbor names every agent) through the REAL
 * folder-trust gate. Claude insets the name into the composer's top rule, so the
 * composer that clears the gate must still read as native chrome.
 * Implements C-E2E-09 and C-TRUST-01.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { cleanup, makeProject, skipIf, skipNow, skipReason, waitFor } from "./helpers.ts";
import { folderTrustScreenVisible } from "./trust-screens.ts";

const name = "Elwood Named Probe";

/** The named session's own trust frame, or why none rendered on this host. */
async function observeTrustGate(session: ClaudeSessionApi): Promise<string | undefined> {
  try {
    return await waitFor(
      () => {
        const text = session.terminal.snapshot().text;
        if (folderTrustScreenVisible(text)) return text;
        return session.status === "ready" ? "" : undefined;
      },
      "named session folder-trust gate",
      90_000,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Timed out waiting for")) return "";
    throw error;
  }
}

test("C-E2E-09 a named Claude session clears the real folder-trust gate and reaches ready", {
  skip: skipIf(skipReason("claude")),
  timeout: 240_000,
}, async (t) => {
  // autotrust: false first, so the run proves this host renders the gate for a named
  // session; otherwise the autotrust half below could pass without exercising it.
  const gated = makeProject("claude");
  let observer: ClaudeSessionApi | undefined;
  try {
    observer = await startClaude({
      cwd: gated.cwd,
      stateDir: gated.stateDir,
      autotrust: false,
      name,
    });
    if (!(await observeTrustGate(observer))) {
      skipNow(t, `no folder-trust gate for a named claude session (status=${observer.status})`);
      return;
    }
  } finally {
    await cleanup(observer);
  }

  const project = makeProject("claude");
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      autotrust: true,
      name,
    });
    await waitFor(
      () => (session?.status === "ready" ? true : undefined),
      "named session reaches ready after autotrust",
      120_000,
    );
    const text = session.terminal.snapshot().text;
    assert.match(
      text,
      /^[─━]{3,} Elwood Named Probe [─━]\s*$/m,
      "the name labels the composer rule",
    );
    assert.equal(folderTrustScreenVisible(text), false, "ready never masks a visible trust gate");
  } finally {
    await cleanup(session);
  }
});
