/**
 * Claude's auto-mode setup offer is a first-party onboarding prompt that blocks an
 * embedded session after a turn. Elwood declines it on its own with Esc (`Not now`),
 * reports that once the offer is gone, and a message held behind it then submits.
 * Implements C-CLAUDE-26 (PRD §5.1).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isClaudeAutoModeOffer } from "../../src/claude/auto-mode-offer.ts";
import { type ClaudeSessionApi, type ElwoodActivityEvent, startClaude } from "../../src/index.ts";
import { offerSessionOptions, offerSetupState, offerShown, seedOffer } from "./auto-mode-offer.ts";
import {
  cleanup,
  hookNamed,
  makeProject,
  observeSession,
  skipIf,
  skipNow,
  skipReason,
  skipTurns,
  waitFor,
} from "./helpers.ts";
import { holdCliOutput, outputMatcher } from "./output-hold.ts";

const answered = outputMatcher(/Yes✔/);
const setupStep = outputMatcher(/Spacetotoggle/);
let offerAnswered = false;
let setupOpened = false;
holdCliOutput({
  output: (data) => {
    offerAnswered ||= answered(data);
    setupOpened ||= setupStep(data);
  },
});

test("C-CLAUDE-26 Elwood declines Claude's auto-mode setup offer, unattended", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: 240_000,
}, async (t) => {
  seedOffer();
  const project = makeProject("claude");
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude(offerSessionOptions(project, "Offer Decline"));
    const live = session;
    const observed = observeSession(live);
    const declines: ElwoodActivityEvent[] = [];
    live.on("activity", (activity) => {
      if (activity.kind === "startup_prompt" && activity.label === "auto_mode_setup")
        declines.push(activity);
    });
    const screen = () => live.terminal.snapshot().text;
    await waitFor(() => (live.status === "ready" ? true : undefined), "initial ready", 120_000);
    await live.sendMessage("Reply with exactly OK.");
    await waitFor(() => hookNamed(observed.hooks, "Stop"), "turn Stop", 90_000);
    if (!(await offerShown(live))) {
      skipNow(t, `Claude did not offer auto-mode setup:\n${screen()}`);
      return;
    }
    // Nobody answers the offer; a message sent now waits behind it.
    const marker = `zq${Date.now().toString(36)}`;
    const sending = live.sendMessage(`Check ${marker}.\nReply with exactly OK. Do not use tools.`);
    // Teardown rejects a still-held send if an assertion below fails first.
    void sending.catch(() => undefined);

    await waitFor(() => declines[0], "Elwood's decline", 15_000);
    assert.ok(!isClaudeAutoModeOffer(screen()), `the offer is gone:\n${screen()}`);
    assert.equal(typeof offerSetupState()?.["dismissedAt"], "number", "Esc chose Not now");
    const submissions = () =>
      observed.hooks.filter(
        (hook) => hook.hook_event_name === "UserPromptSubmit" && hook.prompt.includes(marker),
      ).length;
    await waitFor(() => (submissions() > 0 ? true : undefined), "the held message", 30_000);
    await sending;
    assert.equal(submissions(), 1, "the held message is submitted exactly once");
    assert.equal(declines.length, 1, "one decline is reported");
    assert.equal(offerAnswered, false, "the offer's Yes was never chosen");
    assert.equal(setupOpened, false, "no setup step opened");
    observed.dispose();
  } finally {
    await cleanup(session);
  }
});
