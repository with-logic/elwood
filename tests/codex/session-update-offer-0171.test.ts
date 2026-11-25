/**
 * A Codex session skips the update offer that Codex 0.171 and later draw at start or on
 * resume, and only then writes queued input onto the configured composer. After the skip
 * the real CLI first returns to the unconfigured composer it drew before the offer. The
 * frames are real npm 0.171.0 and standalone 0.172.0 captures (PRD §5.3, §5.5, C-API-28,
 * C-CODEX-27).
 */

import { afterEach, expect, test } from "vitest";
import { unsafeWriteRetryMs } from "../../src/core/input/constants.ts";
import { type CodexSessionApi, resumeCodex, startCodex } from "../../src/index.ts";
import { codexTty, tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

/** Each capture fills all 30 rows; a final newline would scroll the composer off its row. */
const unconfigured = capturedFrame("codex-0.171.0/update/resume-placeholder").trimEnd();
const configured = capturedFrame("codex-0.171.0/update/resume-skipped-composer").trimEnd();
/** The size the captures were taken at, so the configured composer reads as Codex drew it. */
const initialSize = { cols: 100, rows: 30 };

/** Paints a terminal frame on a cleared screen and gives any writer time to write. */
async function render(session: CodexSessionApi, frame: string): Promise<void> {
  ptys.at(-1)!.emitData(`\u001b[2J\u001b[H${frame}`);
  await session.terminal.settled();
  await new Promise((resolve) => setTimeout(resolve, unsafeWriteRetryMs * 2));
}

test.each([
  ["start", "codex-0.171.0/update/offer-npm"],
  ["resume", "codex-0.171.0/update/offer-npm"],
  ["start", "codex-0.172.0/update/offer-standalone-100x30"],
  ["resume", "codex-0.172.0/update/offer-standalone-100x30"],
] as const)("C-CODEX-27 a %s skips the %s offer before queued input", async (launch, capture) => {
  const cwd = tempDir();
  installFakes();
  let session = await startCodex({ cwd, initialSize });
  if (launch === "resume") {
    await becomeReady(session.elwoodSessionId, cwd);
    await session.stop();
    session = await resumeCodex({ cwd, initialSize, elwoodSessionId: session.elwoodSessionId });
  }
  const pty = ptys.at(-1)!;
  try {
    const sent = session.sendMessage("queued at launch");
    sent.catch(() => {});
    // Codex hides the cursor on the offer and shows it again in its composer.
    await render(session, `${tty(capturedFrame(capture))}\u001b[?25l`);
    await expect.poll(() => pty.writes).toEqual(["2"]);
    await render(session, codexTty(unconfigured));
    expect(pty.writes).toEqual(["2"]);
    await render(session, codexTty(configured));
    await sent;
    expect(pty.writes).toEqual(["2", "\u001b[200~queued at launch\u001b[201~", "\r"]);
  } finally {
    await session.stop();
  }
});
