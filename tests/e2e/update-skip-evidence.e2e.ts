/**
 * The update-skip key never reaches an unrelated all-skip-shaped option-only prompt,
 * exercised through a REAL PTY and the real terminal emulator (C-CODEX-22, issue #50).
 *
 * Why a PTY and not a unit test. The guard reads RENDERED frames, so what it actually
 * sees is whatever the emulator produces after real escape sequences, real wrapping and
 * a real clear-screen — not the string a unit test hands it. Issue #50's three failed
 * attempts all passed their synthetic frames; the frame-splitting behaviour that broke
 * them only shows up once something really renders. This paints both frames through a
 * real shell process on a real 100x40 PTY and asserts at the PTY write boundary.
 *
 * The genuine update screen cannot be summoned on demand (it needs an actually-stale
 * binary, see docs/cli-behavior.md), so the ADVERSARIAL prompt is painted instead — which
 * is the case under test. `codex-native-startup.e2e.ts` covers the real Codex startup
 * path against the live CLI.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node-pty";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

/**
 * Paints the measured real split (#50) and then the adversarial prompt: the banner frame
 * carries ONLY `1. Update now`, and the replacement is option-only with EVERY option
 * skip-shaped — and it reassigns `1`, which is the contradiction the guard detects.
 */
const paintScript = [
  `printf 'Update available! 0.151.0 -> 0.152.0\\r\\n  1. Update now'`,
  "sleep 1",
  `printf '\\033[2J\\033[H  1. Skip backup\\r\\n  2. Skip'`,
  "sleep 3",
].join("\n");

test("C-CODEX-22 a real-PTY all-skip-shaped prompt never receives the update-skip key", {
  timeout: 60_000,
}, async (t) => {
  const writes: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "elwood-skip-e2e-"));
  const script = join(dir, "paint.sh");
  writeFileSync(script, paintScript);
  // A plain POSIX shell, deliberately not the user's login shell: this process only
  // PAINTS the frames, and the thing under test is the emulator + guard downstream.
  const child = spawn("/bin/sh", [script], {
    cwd: dir,
    env: { ...process.env, TERM: "xterm-256color" },
    cols: 100,
    rows: 40,
  });
  const terminal = createHeadlessTerminal({ cols: 100, rows: 40 }, () => {});
  const responder = new CodexStartupPromptResponder("e2e");
  const data = child.onData(async (output) => {
    await terminal.writeOutput(output);
    const frame = terminal.snapshot().text;
    // Every automated key Elwood would send to the real Codex process lands here.
    responder.handle(
      frame,
      (input) => {
        writes.push(input);
      },
      () => terminal.snapshot().text,
    );
  });
  try {
    // Let the banner frame paint, be recognized, then be replaced by the unrelated prompt.
    await delay(4_000);
    await terminal.settled();
    const rendered = terminal.snapshot().text;
    assert.match(rendered, /1\.\s*Skip backup/, "the adversarial prompt really rendered");
    assert.doesNotMatch(rendered, /Update available/, "the banner frame was really replaced");
    t.diagnostic(`Real PTY frames rendered; automated writes: ${JSON.stringify(writes)}`);
    // The whole point: no update-skip digit went out into a prompt Elwood never recognized.
    assert.deepEqual(
      writes.filter((write) => /^\d+$/.test(write)),
      [],
      "no update-skip digit reached the unrelated all-skip-shaped prompt",
    );
  } finally {
    data.dispose();
    child.kill("SIGKILL");
    await terminal.settled();
    terminal.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
