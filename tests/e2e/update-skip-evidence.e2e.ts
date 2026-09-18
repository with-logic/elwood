/**
 * The update-skip key never reaches a prompt that contradicts the captured appearance,
 * exercised through a REAL PTY and the real terminal emulator (C-CODEX-22, issue #50).
 *
 * Why a PTY and not a unit test. The guard reads RENDERED frames, so what it actually
 * sees is whatever the emulator produces after real escape sequences, real wrapping and
 * a real clear-screen — not the string a unit test hands it. Issue #50's three failed
 * attempts all passed their synthetic frames; the frame-splitting behaviour that broke
 * them only shows up once something really renders. This paints the frames through a
 * real shell process on a real 100x40 PTY and asserts at the PTY write boundary.
 *
 * The genuine update screen cannot be summoned on demand (it needs an actually-stale
 * binary, see docs/cli-behavior.md), so the ADVERSARIAL prompts are painted instead —
 * which is the case under test. `codex-native-startup.e2e.ts` covers the real Codex
 * startup path against the live CLI.
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

/** The measured real split (#50): the banner frame carries ONLY `1. Update now`. */
const bannerPaint = `printf 'Update available! 0.151.0 -> 0.152.0\\r\\n  1. Update now'`;

/**
 * Paints the banner frame, then a replacement, and reports every automated key the real
 * responder tried to send. The replacement always reassigns `1` — the contradiction the
 * guard detects — so no digit may go out whatever the replacement's overall shape is.
 */
async function automatedWritesAfterReplacement(
  replacement: string,
): Promise<{ readonly writes: readonly string[]; readonly rendered: string }> {
  const dir = mkdtempSync(join(tmpdir(), "elwood-skip-e2e-"));
  const script = join(dir, "paint.sh");
  writeFileSync(
    script,
    [bannerPaint, "sleep 1", `printf '\\033[2J\\033[H${replacement}'`, "sleep 3"].join("\n"),
  );
  const writes: string[] = [];
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
    // Every automated key Elwood would send to the real Codex process lands here.
    responder.handle(
      terminal.snapshot().text,
      (input) => {
        writes.push(input);
      },
      () => terminal.snapshot().text,
    );
  });
  try {
    // Let the banner frame paint, be recognized, then be replaced.
    await delay(4_000);
    await terminal.settled();
    return { writes, rendered: terminal.snapshot().text };
  } finally {
    data.dispose();
    child.kill("SIGKILL");
    await terminal.settled();
    terminal.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("C-CODEX-22 a real-PTY all-skip-shaped prompt never receives the update-skip key", {
  timeout: 60_000,
}, async (t) => {
  // An UNRELATED option-only prompt: every option is skip-shaped, so on its own frame it
  // is shaped exactly like a legitimate update continuation.
  const { writes, rendered } = await automatedWritesAfterReplacement(
    "  1. Skip backup\\r\\n  2. Skip",
  );
  assert.match(rendered, /1\.\s*Skip backup/, "the adversarial prompt really rendered");
  assert.doesNotMatch(rendered, /Update available/, "the banner frame was really replaced");
  t.diagnostic(`Real PTY frames rendered; automated writes: ${JSON.stringify(writes)}`);
  assert.deepEqual(
    writes.filter((write) => /^\d+$/.test(write)),
    [],
    "no update-skip digit reached the unrelated all-skip-shaped prompt",
  );
});

test("C-CODEX-22 a real-PTY first-party-shaped replacement never inherits the skip key", {
  timeout: 60_000,
}, async (t) => {
  // A COMPLETE-looking update screen that reassigns the captured `1`. Recognizing it as
  // first-party is correct; letting it inherit the previous appearance's authorization is
  // not, because the running attempt would press `1` — now `Skip backup` — on a new dialog.
  const { writes, rendered } = await automatedWritesAfterReplacement(
    "  1. Skip backup\\r\\n  2. Update now",
  );
  assert.match(rendered, /1\.\s*Skip backup/, "the replacement dialog really rendered");
  assert.match(rendered, /2\.\s*Update now/, "the replacement really looks first-party");
  t.diagnostic(`Real PTY frames rendered; automated writes: ${JSON.stringify(writes)}`);
  assert.ok(
    !writes.includes("1"),
    `the digit bound to the captured "Update now" must not be pressed on a dialog that reassigned it; got ${JSON.stringify(writes)}`,
  );
});
