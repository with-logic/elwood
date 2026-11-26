/**
 * The lazy `CodexSession` facade: a `dialog` listener registered before `start()` receives
 * the update offer Codex drew while startup was still open, and the facade lists it (PRD
 * §5.13 "Codex update offers", C-ATTN-12).
 */

import { afterEach, assert, expect, test, vi } from "vitest";
import { CodexSession, type ElwoodDialogEvent } from "../../src/index.ts";
import { tty } from "../fixtures/trust-composer.ts";
import { holdStartup } from "../helpers/startup-frame.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { noSafeChoice } from "./update-dialog-fixture.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test("C-ATTN-12 a lazy listener registered before start receives an offer drawn during startup", async () => {
  installFakes();
  const session = new CodexSession({ cwd: tempDir(), initialSize: { cols: 100, rows: 30 } });
  const events: ElwoodDialogEvent[] = [];
  session.on("dialog", (event) => {
    events.push(event);
  });
  const held = await holdStartup(() => session.start());
  try {
    const pty = ptys[0];
    assert.isDefined(pty);
    // Elwood has no safe choice to type on this offer, so it is listed at once. Codex hides
    // the cursor on the offer.
    pty.emitData(`\u001b[2J\u001b[H${tty(noSafeChoice)}\u001b[?25l`);
    await expect.poll(held.renders).toBe(1);
    expect(session.session).toBeUndefined();
    held.release();
    await held.starting;
    await expect.poll(() => events.length).toBe(1);
    const requests = await session.listDialogs();
    expect(requests.map((request) => request.kind)).toEqual(["update"]);
    expect(events).toEqual([{ phase: "raised", request: requests[0] }]);
  } finally {
    await held.settle();
    await session.teardown();
  }
});
