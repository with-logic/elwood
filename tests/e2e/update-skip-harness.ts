/**
 * Real-PTY harness for the Codex update-prompt guard tests (C-CODEX-22, issue #50).
 * Paints adversarial frames through a real shell process and the real terminal emulator,
 * then reports what the guard did: the automated keys it tried to send, or the session's
 * `blocking_prompt_visible` fact.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node-pty";
import { codexScreenFactTableForTrustPolicy } from "../../src/codex/screen-table.ts";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

/** The measured real split (#50): the banner frame carries ONLY `1. Update now`. */
export const bannerPaint = `printf 'Update available! 0.151.0 -> 0.152.0\\r\\n  1. Update now'`;
/** A COMPLETE update screen, so a skip attempt is genuinely in flight before the swap. */
export const completeUpdatePaint = `printf 'Update available! 0.151.0 -> 0.152.0\\r\\n  1. Update now\\r\\n  2. Skip'`;
/** Long enough to cover the responder's retry interval, so a live retry gets its chance. */
const retryBudgetMs = 1_200;

/** Polls the rendered frame until `pattern` appears, so no assertion races the paint. */
async function waitForRendered(
  terminal: { snapshot: () => { text: string } },
  pattern: RegExp,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(terminal.snapshot().text)) return;
    await delay(25);
  }
  throw new Error(`Frame matching ${pattern} never rendered`);
}

/**
 * Paints the banner frame, then a replacement, and reports every automated key the real
 * responder tried to send. The replacement always reassigns `1` — the contradiction the
 * guard detects — so no digit may go out whatever the replacement's overall shape is.
 */
export async function automatedWritesAfterReplacement(
  replacement: string,
  firstPaint: string = bannerPaint,
): Promise<{ readonly writes: readonly string[]; readonly rendered: string }> {
  const dir = mkdtempSync(join(tmpdir(), "elwood-skip-e2e-"));
  const script = join(dir, "paint.sh");
  writeFileSync(
    script,
    [firstPaint, "sleep 1", `printf '\\033[2J\\033[H${replacement}'`, "sleep 3"].join("\n"),
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
  // Every frame's processing is TRACKED, not fire-and-forget: `terminal.settled()` waits
  // for the emulator, not for `responder.handle`, so without this the assertions could
  // run before the guard ever saw the replacement and pass without exercising it.
  const processed: Promise<void>[] = [];
  const data = child.onData((output) => {
    processed.push(
      (async () => {
        await terminal.writeOutput(output);
        // Every automated key Elwood would send to the real Codex process lands here.
        responder.handle(
          terminal.snapshot().text,
          (input) => {
            writes.push(input);
          },
          () => terminal.snapshot().text,
        );
      })(),
    );
  });
  try {
    // Wait for the REPLACEMENT to actually render rather than sleeping a fixed time, then
    // drain every frame's processing before reading the result.
    await waitForRendered(terminal, /1\.\s*Skip backup/);
    await delay(retryBudgetMs);
    await terminal.settled();
    await Promise.all(processed);
    return { writes, rendered: terminal.snapshot().text };
  } finally {
    data.dispose();
    child.kill("SIGKILL");
    await terminal.settled();
    terminal.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Paints the same two frames and reports the session-level `blocking_prompt_visible` fact
 * on the replacement frame, read through the table a real session runs.
 */
export async function blockingAcrossReplacement(
  replacement: string,
  firstPaint: string = bannerPaint,
): Promise<{ readonly blocking: boolean; readonly rendered: string }> {
  const dir = mkdtempSync(join(tmpdir(), "elwood-hold-e2e-"));
  const script = join(dir, "paint.sh");
  writeFileSync(
    script,
    [firstPaint, "sleep 1", `printf '\\033[2J\\033[H${replacement}'`, "sleep 3"].join("\n"),
  );
  const child = spawn("/bin/sh", [script], {
    cwd: dir,
    env: { ...process.env, TERM: "xterm-256color" },
    cols: 100,
    rows: 40,
  });
  const terminal = createHeadlessTerminal({ cols: 100, rows: 40 }, () => {});
  const table = codexScreenFactTableForTrustPolicy(false);
  let blocking = false;
  // Tracked, not fire-and-forget, for the same reason as above: the fact must be read
  // from a frame the table has actually observed.
  const processed: Promise<void>[] = [];
  const data = child.onData((output) => {
    processed.push(
      (async () => {
        await terminal.writeOutput(output);
        const frame = { text: terminal.snapshot().text, title: "" };
        blocking = readScreenFacts(table, frame).facts.blocking_prompt_visible === true;
      })(),
    );
  });
  try {
    await waitForRendered(terminal, /1\.\s*Skip backup/);
    await terminal.settled();
    await Promise.all(processed);
    return { blocking, rendered: terminal.snapshot().text };
  } finally {
    data.dispose();
    child.kill("SIGKILL");
    await terminal.settled();
    terminal.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}
