/**
 * A named Claude session (`name`, as Coal Harbor names every agent) through the REAL
 * folder-trust gate. Claude insets the name into the composer's top rule, so the
 * composer that clears the gate must still read as native chrome.
 * Implements C-E2E-09 and C-TRUST-01.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { cleanup, makeProject, skipIf, skipReason, waitFor } from "./helpers.ts";
import { folderTrustScreenVisible } from "./trust-screens.ts";

test("C-E2E-09 a named Claude session clears the real folder-trust gate and reaches ready", {
  skip: skipIf(skipReason("claude")),
  timeout: 150_000,
}, async () => {
  const project = makeProject("claude");
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      autotrust: true,
      name: "Elwood Named Probe",
    });
    await waitFor(
      () => (session?.status === "ready" ? true : undefined),
      "named session reaches ready after autotrust",
      120_000,
    );
    const text = session.terminal.snapshot().text;
    assert.match(text, /^[─━]{3,} Elwood Named Probe [─━]\s*$/m, "the name labels the composer rule");
    assert.equal(folderTrustScreenVisible(text), false, "ready never masks a visible trust gate");
  } finally {
    await cleanup(session);
  }
});
