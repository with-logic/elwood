/**
 * Real-CLI image attachment: `sendMessage({ images })` drives each CLI's native
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
    // Attach the image and assert the composer shows the chip. The submission
    // promise is held so its post-teardown rejection never leaks as unhandled.
    const submitted = session
      .sendMessage("here is an image", { images: [{ path: image }] })
      .catch(() => undefined);
    await waitFor(
      () => (/\[Image #\d/.test(session!.terminal.snapshot().text) ? true : undefined),
      "Claude [Image #N] composer chip",
    );
    assert.match(session.terminal.snapshot().text, /\[Image #\d/);
    await cleanup(session);
    session = undefined;
    await submitted; // settle the held submission after teardown (never unhandled)
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
  let session: CodexSession | undefined;
  try {
    session = await startCodex({ cwd: project.cwd, stateDir: project.stateDir, autotrust: true });
    await prepareInteractivePrompt(session, observeSession(session), "codex");
    const submitted = session
      .sendMessage("here is an image", { images: [{ path: image }] })
      .catch(() => undefined);
    await waitFor(
      () => (/\[Image #\d/.test(session!.terminal.snapshot().text) ? true : undefined),
      "Codex [Image #N] composer chip",
    );
    assert.match(session.terminal.snapshot().text, /\[Image #\d/);
    await cleanup(session);
    session = undefined;
    await submitted; // settle the held submission after teardown (never unhandled)
  } finally {
    await cleanup(session);
    // The attach restores the prior clipboard; put back whatever we snapshotted
    // regardless, so a test failure never leaves the dev's clipboard clobbered.
    execFileSync("/usr/bin/pbcopy", { input: priorClipboard });
  }
});
