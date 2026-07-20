/**
 * Real-CLI image attachment: `sendMessage(message, { images })` drives each CLI's native
 * ingestion so an `[Image #N]` chip actually renders in the composer. This is the
 * external-system check the feature needs — the attach mechanisms are
 * version-coupled CLI behavior that only a real CLI can validate.
 * Implements C-E2E-12 (Claude, C-API-45) and C-E2E-13 (Codex, C-API-46).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type ClaudeSession, type CodexSession, startClaude, startCodex } from "../../src/index.ts";
import {
  cleanup,
  makeProject,
  observeSession,
  prepareInteractivePrompt,
  skipReason,
  waitFor,
} from "./helpers.ts";

const fixture = join(import.meta.dirname, "..", "fixtures", "sample.png");

test("C-E2E-12 Claude attaches a pasted image path (real CLI shows [Image #N])", {
  skip: skipReason("claude"),
  timeout: 120_000,
}, async () => {
  const project = makeProject("claude");
  const image = join(project.cwd, "shot.png");
  copyFileSync(fixture, image);
  let session: ClaudeSession | undefined;
  try {
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      autotrust: true,
    });
    await prepareInteractivePrompt(session, observeSession(session), "claude");
    // Attach the image + text as ONE submission and require it to SUCCEED — the
    // rejection is NOT swallowed, so a failure to submit the combined turn fails
    // the test (C-API-44). The chip proves the image reached the composer.
    const submitted = session.sendMessage("here is an image", { images: [{ path: image }] });
    await waitFor(
      () => (/\[Image #\d/.test(session!.terminal.snapshot().text) ? true : undefined),
      "Claude [Image #N] composer chip",
    );
    assert.match(session.terminal.snapshot().text, /\[Image #\d/);
    await submitted; // the combined image+text submission resolves (no swallow)
  } finally {
    await cleanup(session);
  }
});

const macOnly = process.platform === "darwin" ? false : "Codex image attach is macOS-only";

test("C-E2E-13 Codex attaches a clipboard image and restores the clipboard (real CLI)", {
  skip: macOnly || skipReason("codex"),
  timeout: 120_000,
}, async () => {
  const project = makeProject("codex");
  const image = join(project.cwd, "shot.png");
  copyFileSync(fixture, image);
  const priorClipboard = execFileSync("/usr/bin/pbpaste").toString();
  // Plant a KNOWN sentinel so we can prove PRODUCTION restored it (not our finally).
  const sentinel = "elwood-e2e-clipboard-sentinel";
  execFileSync("/usr/bin/pbcopy", { input: sentinel });
  let session: CodexSession | undefined;
  try {
    session = await startCodex({ cwd: project.cwd, stateDir: project.stateDir, autotrust: true });
    await prepareInteractivePrompt(session, observeSession(session), "codex");
    const submitted = session.sendMessage("here is an image", { images: [{ path: image }] });
    await waitFor(
      () => (/\[Image #\d/.test(session!.terminal.snapshot().text) ? true : undefined),
      "Codex [Image #N] composer chip",
    );
    assert.match(session.terminal.snapshot().text, /\[Image #\d/);
    await submitted; // the attach completed (chip seen); restoration has run
    // Production restored the sentinel — the injected image is no longer the
    // clipboard, proving snapshot-and-restore actually happened (C-API-46).
    assert.equal(execFileSync("/usr/bin/pbpaste").toString(), sentinel);
  } finally {
    await cleanup(session);
    execFileSync("/usr/bin/pbcopy", { input: priorClipboard }); // restore dev's real clipboard
  }
});
