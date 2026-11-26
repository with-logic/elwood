/**
 * Claude mounts its auto-mode offer when a turn's query ends and takes keys from then on,
 * but Elwood only sees the offer once its frame arrives. Here Elwood's view of the CLI is
 * held back from the turn's `Stop`, so a message queued during the turn goes out while the
 * offer is mounted and, to Elwood, unpainted. The message must not answer the offer: it is
 * submitted exactly once, after Elwood declines the offer. Implements C-ATTN-10 (PRD §5.3)
 * and C-CLAUDE-27 (PRD §5.1).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import {
  offerActions,
  offerSessionOptions,
  offerSetupState,
  offerShown,
  seedOffer,
} from "./auto-mode-offer.ts";
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
import { type HeldOutput, holdCliOutput } from "./output-hold.ts";

/** How long Elwood's view trails the CLI after `Stop`: far past the offer's paint. */
const lagMs = 1_500;
/** After the turn it starts, long enough for a second submission to have shown up. */
const settleMs = 2_000;

let held: HeldOutput | undefined;
const actions = offerActions();
holdCliOutput({
  output: (data, output) => {
    held = output;
    actions.observe(data);
  },
});

test("C-ATTN-10 a message queued during a turn is not taken by an offer Elwood has not seen", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: 240_000,
}, async (t) => {
  seedOffer();
  const project = makeProject("claude");
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude(offerSessionOptions(project, "Offer Prepaint"));
    const live = session;
    const observed = observeSession(live);
    await waitFor(() => (live.status === "ready" ? true : undefined), "initial ready", 120_000);
    live.on("hook", (hook) => {
      if (hook.hook_event_name === "Stop") held?.hold(lagMs);
    });
    await live.sendMessage("Reply with exactly OK.");
    await waitFor(() => (live.status === "running" ? true : undefined), "turn running", 30_000);
    const marker = `zq${Date.now().toString(36)}`;
    const sending = live.sendMessage(`Check ${marker}.\nReply with exactly OK. Do not use tools.`);
    // Teardown rejects a still-held send if an assertion below fails first.
    void sending.catch(() => undefined);
    await waitFor(() => hookNamed(observed.hooks, "Stop"), "turn Stop", 90_000);
    if (!(await offerShown(live))) {
      skipNow(t, `Claude did not offer auto-mode setup:\n${live.terminal.snapshot().text}`);
      return;
    }
    const hooksBefore = observed.hooks.length;
    const submissions = () =>
      observed.hooks.filter(
        (hook) => hook.hook_event_name === "UserPromptSubmit" && hook.prompt.includes(marker),
      ).length;
    await waitFor(() => (submissions() > 0 ? true : undefined), "the queued message", 30_000);
    await waitFor(() => hookNamed(observed.hooks.slice(hooksBefore), "Stop"), "its Stop", 90_000);
    await sending;
    await delay(settleMs);
    assert.equal(submissions(), 1, "the queued message is submitted exactly once");
    assert.equal(actions.offerAnswered, false, "the offer's Yes was never chosen");
    assert.equal(actions.setupOpened, false, "no setup step opened");
    assert.equal(
      typeof offerSetupState()?.["dismissedAt"],
      "number",
      "Elwood's Esc declined the offer",
    );
    observed.dispose();
  } finally {
    await cleanup(session);
  }
});
