/**
 * Real-CLI image attachment: `sendMessage(message, { images })` drives each CLI's native
 * ingestion so an `[Image #N]` chip actually renders in the composer. This is the
 * external-system check the feature needs — the attach mechanisms are
 * version-coupled CLI behavior that only a real CLI can validate.
 * Implements C-E2E-12 (Claude, C-API-45) and C-E2E-13 (Codex, C-API-46), including the
 * removal of the temp copy Codex saves of each pasted image.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { clipboardCopyAt, localImagePathsIn } from "../../src/codex/images/clipboard-copies.ts";
import {
  type ClaudeSessionApi,
  type CodexSessionApi,
  startClaude,
  startCodex,
} from "../../src/index.ts";
import {
  cleanup,
  makeProject,
  observeSession,
  prepareInteractivePrompt,
  skipIf,
  skipNow,
  skipReason,
  waitFor,
} from "./helpers.ts";

const fixture = join(import.meta.dirname, "..", "fixtures", "sample.png");

test("C-E2E-12 Claude attaches a pasted image path (real CLI shows [Image #N])", {
  skip: skipIf(skipReason("claude")),
  timeout: 120_000,
}, async () => {
  const project = makeProject("claude");
  const image = join(project.cwd, "shot.png");
  copyFileSync(fixture, image);
  let session: ClaudeSessionApi | undefined;
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
  skip: skipIf(macOnly, skipReason("codex")),
  timeout: 120_000,
}, async (t) => {
  const project = makeProject("codex");
  const image = join(project.cwd, "shot.png");
  copyFileSync(fixture, image);
  const priorClipboard = execFileSync("/usr/bin/pbpaste").toString();
  // Plant a KNOWN sentinel so we can prove PRODUCTION restored it (not our finally).
  const sentinel = "elwood-e2e-clipboard-sentinel";
  execFileSync("/usr/bin/pbcopy", { input: sentinel });
  let session: CodexSessionApi | undefined;
  const namedImagePaths: string[] = [];
  let copy: string | undefined;
  try {
    session = await startCodex({ cwd: project.cwd, stateDir: project.stateDir, autotrust: true });
    session.on("codex:transcript", ({ item }) => namedImagePaths.push(...localImagePathsIn(item)));
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
    // Codex saved the pasted image to a temp file its transcript names.
    const named = await waitFor(() => namedImagePaths[0], "the submitted image in the transcript");
    const tempDir = resolve(tmpdir());
    if (resolve(dirname(named)) !== tempDir) {
      // Codex's login shell gave it another TMPDIR: the copy is not the session's (§5.3).
      skipNow(t, `Codex saved the pasted image outside Elwood's temp dir: ${named}`);
      return;
    }
    copy = clipboardCopyAt(named, tempDir);
    assert.ok(copy, `the session owns Codex's copy ${named}`);
    assert.equal(existsSync(copy), true, "Codex saved the pasted image");
  } finally {
    await cleanup(session);
    execFileSync("/usr/bin/pbcopy", { input: priorClipboard }); // restore dev's real clipboard
  }
  assert.ok(
    copy !== undefined && !existsSync(copy),
    "the session removed Codex's copy when it ended",
  );
});
