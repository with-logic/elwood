/**
 * A resumed Codex session reaches ready on its first configured composer, not on a bare
 * composer marker, without waiting for `SessionStart`, and not on one that PTY output
 * already received replaces. Covers PRD §5.3 and C-API-28.
 */

import { afterEach, expect, test, vi } from "vitest";
import { type ElwoodSessionStatus, resumeCodex, startCodex } from "../../src/index.ts";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

const composer = `\u001b[2J\u001b[H${codexTty(codexComposer)}`;
const approval =
  "\u001b[2J\u001b[HWould you like to run the following command?\r\n› 1. Yes\r\n  2. No\r\nPress enter to confirm or esc to cancel";

async function resumeWithQueuedMessage() {
  const cwd = tempDir();
  installFakes();
  const session = await startCodex({ cwd });
  await becomeReady(session.elwoodSessionId, cwd);
  await session.stop();
  const resumed = await resumeCodex({ cwd, elwoodSessionId: session.elwoodSessionId });
  return { resumed, queued: resumed.sendMessage("queued at resume") };
}

test("C-API-28 resume reaches ready on the first configured composer (no SessionStart needed)", async () => {
  // Resume, then render composer frames WITHOUT dispatching SessionStart (the CLI does not
  // re-fire it on resume). A bare composer marker is not enough: the resume placeholder and
  // an unrecognized menu's selected row carry it too. The configured composer is, so the
  // session reaches ready without waiting out the deadline.
  const { resumed, queued } = await resumeWithQueuedMessage();
  const render = async (frame: string) => {
    ptys[1]!.emitData(`\u001b[2J\u001b[H${frame}`);
    await resumed.terminal.settled(); // flush the write -> render -> readiness chain
    await new Promise((r) => setImmediate(r));
  };
  await render("› ");
  expect(resumed.status).not.toBe("ready");
  expect(ptys[1]!.writes).toEqual([]);
  await render(codexTty(codexComposer));
  await queued;
  expect(ptys[1]!.writes.join("")).toContain("queued at resume");
});

test("C-API-28 resume does not mark on a configured composer that received PTY output replaces", async () => {
  const { resumed, queued } = await resumeWithQueuedMessage();
  const statuses: ElwoodSessionStatus[] = [];
  resumed.on("status", ({ status }) => statuses.push(status));
  const { xterm } = resumed.terminal;
  const write = xterm.write.bind(xterm);
  const held: (() => void)[] = [];
  const hold = vi.spyOn(xterm, "write").mockImplementation((data, done) => {
    held.push(() => write(data, done));
  });
  // Each staged batch reaches xterm, where it is held.
  ptys[1]!.emitData(composer);
  await vi.waitFor(() => expect(held).toHaveLength(1));
  ptys[1]!.emitData(approval);
  await vi.waitFor(() => expect(held).toHaveLength(2));
  hold.mockRestore();
  // The composer draws while the dialog that replaces it is still undrawn.
  held[0]!();
  await new Promise((r) => setTimeout(r, 50));
  expect(statuses).toEqual([]);
  held[1]!();
  await resumed.terminal.settled();
  await new Promise((r) => setImmediate(r));
  expect(statuses).toEqual(["blocked"]);
  expect(ptys[1]!.writes).toEqual([]);
  ptys[1]!.emitData(composer);
  await resumed.terminal.settled();
  await queued;
  expect(ptys[1]!.writes.join("")).toContain("queued at resume");
});
