/**
 * Before its first readiness, a Codex session writes a `sendPrompt` or a picker command
 * only onto its configured composer: a bare composer marker can be an unrecognized
 * startup screen's selected row, such as Codex 0.171.0's `› 1. Update now`. Covers PRD
 * §5.3 and C-API-28.
 */

import { afterEach, expect, test } from "vitest";
import { unsafeWriteRetryMs } from "../../src/core/input/constants.ts";
import { type CodexSessionApi, resumeCodex, startCodex } from "../../src/index.ts";
import { codexComposer, codexTty, tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

/** Codex 0.171.0's update offer, which Elwood does not recognize. */
const offer = capturedFrame("codex-0.171.0/update/offer-npm");
/** Two write retries: a writer the hold had released would have written by then. */
const settleMs = unsafeWriteRetryMs * 2;

/** Paints `frame` on a cleared screen and gives any released writer time to write. */
async function render(session: CodexSessionApi, frame: string): Promise<void> {
  ptys.at(-1)!.emitData(`\u001b[2J\u001b[H${frame}`);
  await session.terminal.settled();
  await new Promise((resolve) => setTimeout(resolve, settleMs));
}

test.each([
  "start",
  "resume",
] as const)("C-API-28 a %s holds sendPrompt until the configured composer", async (launch) => {
  const cwd = tempDir();
  installFakes();
  let session = await startCodex({ cwd });
  if (launch === "resume") {
    await becomeReady(session.elwoodSessionId, cwd);
    await session.stop();
    session = await resumeCodex({ cwd, elwoodSessionId: session.elwoodSessionId });
  }
  const pty = ptys.at(-1)!;
  try {
    const sent = session.sendPrompt("held prompt");
    sent.catch(() => {});
    await render(session, tty(offer));
    await render(session, "› ");
    expect(pty.writes).toEqual([]);
    await render(session, codexTty(codexComposer));
    await sent;
    expect(pty.writes).toEqual(["\u001b[200~held prompt\u001b[201~", "\r"]);
  } finally {
    await session.stop();
  }
});

test("C-API-28 a readiness hook releases a held sendPrompt without a configured composer", async () => {
  const cwd = tempDir();
  installFakes();
  const session = await startCodex({ cwd });
  const pty = ptys[0]!;
  try {
    const sent = session.sendPrompt("held prompt");
    sent.catch(() => {});
    await render(session, tty(offer));
    expect(pty.writes).toEqual([]);
    await becomeReady(session.elwoodSessionId, cwd);
    await sent;
    expect(pty.writes).toEqual(["\u001b[200~held prompt\u001b[201~", "\r"]);
  } finally {
    await session.stop();
  }
});

test.each([
  ["listModels", (session: CodexSessionApi) => session.listModels({ timeoutMs: 30_000 })],
  ["setModel", (session: CodexSessionApi) => session.setModel("gpt-5.4", { timeoutMs: 30_000 })],
] as const)("C-API-28 a start holds %s's /model until the configured composer", async (_, run) => {
  installFakes();
  const session = await startCodex({ cwd: tempDir() });
  const pty = ptys[0]!;
  try {
    const picking = run(session);
    picking.catch(() => {});
    await render(session, tty(offer));
    expect(pty.writes).toEqual([]);
    await render(session, codexTty(codexComposer));
    await expect.poll(() => pty.writes.join("")).toContain("/model");
  } finally {
    await session.stop();
  }
});

test("C-API-28 a picker command held past its deadline reports it was never written", async () => {
  installFakes();
  const session = await startCodex({ cwd: tempDir() });
  try {
    const listing = session.listModels({ timeoutMs: 300 });
    const rejected = expect(listing).rejects.toMatchObject({
      code: "model_automation_failed",
      message: "Timed out before the command that opens the codex model picker could be submitted.",
    });
    await render(session, tty(offer));
    await rejected;
    expect(ptys[0]!.writes).toEqual([]);
  } finally {
    await session.stop();
  }
});
