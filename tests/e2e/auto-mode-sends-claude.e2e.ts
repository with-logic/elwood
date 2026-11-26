/**
 * Two `ClaudeSession.send` turns in auto mode, with the auto-mode offer snoozed so that only
 * the turns run. The first send completes on its `Stop` and transcript while Claude still
 * draws the turn as working, so its writer is cancelled with the draft already taken. The
 * turn-end hold then keeps the screen still, and clear keys sent to the idle composer would
 * repaint nothing. The second send must submit its own turn and answer from the first turn's
 * context, with an answer the first reply does not contain.
 * Implements C-API-56 and C-ATTN-10 (PRD §5.3, §5.8).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { claudeAutoModeOfferRuleId } from "../../src/claude/auto-mode/offer.ts";
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
  const submitted: string[] = [];
  session.on("activity", (event) => {
    if (event.kind === "attention" && event.label === claudeAutoModeOfferRuleId)
      offered.push(event.label);
    if (event.kind === "user_message" && event.source === "hook") submitted.push(event.text);
  });
  const secondPrompt = "Add 25 to the number I asked you to remember. Reply with only the sum.";
  try {
    const first = await session.send(
      "Remember the number 17 for my next message. Reply with only the word OK.",
      { timeoutMs: 90_000 },
    );
    assert.ok(first.trim().length > 0, "the first send returns assistant text");
    assert.doesNotMatch(first, /42/, "the first reply cannot satisfy the second turn's check");
    const second = await session.send(secondPrompt, { timeoutMs: 90_000 });
    assert.ok(submitted.includes(secondPrompt), "Claude's UserPromptSubmit saw the second send");
    assert.match(second, /\b42\b/, "the second turn answers from first-turn context");
    assert.ok(!writes.includes(composerClearKeys), "no clear keys went to the composer");
    assert.deepEqual(offered, [], "the snoozed offer did not show");
    assert.equal(offerSetupState()?.["dismissedAt"], dismissedAt, "the snooze stayed as seeded");
  } finally {
    await session.close();
  }
});
