/**
 * Before its first readiness, a Claude session writes a `sendPrompt` or its `login`
 * command only onto its verified idle composer, never onto a bare `❯` marker. Covers PRD
 * §5.3 and C-API-28.
 */

import { afterEach, expect, test } from "vitest";
import { unsafeWriteRetryMs } from "../../src/core/input/constants.ts";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

/** Two write retries: a writer the hold had released would have written by then. */
const settleMs = unsafeWriteRetryMs * 2;

/** Paints `frame` on a cleared screen and gives any released writer time to write. */
async function render(session: ClaudeSessionApi, frame: string): Promise<void> {
  ptys[0]!.emitData(`\u001b[2J\u001b[H${frame}`);
  await session.terminal.settled();
  await new Promise((resolve) => setTimeout(resolve, settleMs));
}

test("C-API-28 a start holds sendPrompt on a bare marker until the idle composer", async () => {
  installFakes();
  const session = await startClaude({ cwd: tempDir() });
  const pty = ptys[0]!;
  try {
    const sent = session.sendPrompt("held prompt");
    sent.catch(() => {});
    await render(session, "❯ ");
    expect(pty.writes).toEqual([]);
    await render(session, claudeTty(claudeComposer));
    await sent;
    expect(pty.writes).toEqual(["\u001b[200~held prompt\u001b[201~", "\r"]);
  } finally {
    await session.stop();
  }
});

test("C-API-28 a start holds login's /login on a bare marker until the idle composer", async () => {
  installFakes();
  const session = await startClaude({ cwd: tempDir() });
  const pty = ptys[0]!;
  try {
    const loggingIn = session.login({ provideCode: () => "unused", timeoutMs: 30_000 });
    loggingIn.catch(() => {});
    await render(session, "❯ ");
    expect(pty.writes).toEqual([]);
    await render(session, claudeTty(claudeComposer));
    await expect.poll(() => pty.writes).toContain("/login");
  } finally {
    await session.stop();
  }
});
