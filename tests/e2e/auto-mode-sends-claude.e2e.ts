/**
 * Two `ClaudeSession.send` turns in auto mode, with the auto-mode offer snoozed so that only
 * the turns run. The first send completes on its `Stop` and transcript while Claude still
 * draws the turn as working, so its writer is cancelled with the draft already taken. The
 * turn-end hold then keeps the screen still, and clear keys sent to the idle composer would
 * repaint nothing. The second send must submit and answer from the first turn's context.
 * Implements C-API-56 and C-ATTN-10 (PRD §5.3, §5.8).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { claudeAutoModeOfferRuleId } from "../../src/claude/auto-mode-offer.ts";
import { composerClearKeys } from "../../src/core/input/constants.ts";
import { ClaudeSession } from "../../src/index.ts";
import { offerSetupState, seedSnoozedOffer } from "./auto-mode-offer.ts";
import { makeProject, skipIf, skipReason, skipTurns } from "./helpers.ts";
import { holdCliOutput } from "./output-hold.ts";

/** Every string Elwood writes to Claude in this process, in order; nothing is held. */
const writes: string[] = [];
holdCliOutput({ input: (data) => writes.push(data) });

test("C-API-56 C-ATTN-10 a second ClaudeSession.send follows an auto-mode turn", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: 240_000,
}, async () => {
  const dismissedAt = seedSnoozedOffer();
  const project = makeProject("claude");
  const session = new ClaudeSession({
    cwd: project.cwd,
    stateDir: project.stateDir,
    autotrust: true,
    autoupdate: false,
    model: "haiku",
    permissionMode: "auto",
    initialSize: { cols: 140, rows: 40 },
  });
  const offered: string[] = [];
  session.on("activity", (event) => {
    if (event.kind === "attention" && event.label === claudeAutoModeOfferRuleId)
      offered.push(event.label);
  });
  try {
    const first = await session.send(
      "My favorite animal is the axolotl. Reply with just one short sentence acknowledging that.",
      { timeoutMs: 90_000 },
    );
    assert.ok(first.trim().length > 0, "the first send returns assistant text");
    const second = await session.send(
      "What did I say my favorite animal was? Answer with just the animal name.",
      { timeoutMs: 90_000 },
    );
    assert.match(second.toLowerCase(), /axolotl/, "the second turn retains first-turn context");
    assert.ok(!writes.includes(composerClearKeys), "no clear keys went to the composer");
    assert.deepEqual(offered, [], "the snoozed offer did not show");
    assert.equal(offerSetupState()?.["dismissedAt"], dismissedAt, "the snooze stayed as seeded");
  } finally {
    await session.close();
  }
});
