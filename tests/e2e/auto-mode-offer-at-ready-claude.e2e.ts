/**
 * A caller that sends the moment a Claude turn's `Stop` reports `ready` reaches Claude while
 * the auto-mode offer that turn's end mounted may not have painted yet. The message must not
 * answer the offer: it is submitted exactly once, after Elwood declines the offer. One run holds
 * Elwood's view of the CLI back from `Stop`, so the offer is mounted and, to Elwood,
 * unpainted; the other runs at live speed with a status observer that throws at that `ready`.
 * Implements C-ATTN-10 (PRD §5.3) and C-CLAUDE-26 (PRD §5.1).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
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
import { type HeldOutput, holdCliOutput, outputMatcher } from "./output-hold.ts";

/** How long Elwood's view trails the CLI after `Stop`: far past the offer's paint. */
const lagMs = 1_500;
/** After the turn it starts, long enough for a second submission to have shown up. */
const settleMs = 2_000;

let held: HeldOutput | undefined;
let answered = outputMatcher(/Yes✔/);
let setupStep = outputMatcher(/Spacetotoggle/);
let offerAnswered = false;
let setupOpened = false;
holdCliOutput({
  output: (data, output) => {
    held = output;
    offerAnswered ||= answered(data);
    setupOpened ||= setupStep(data);
  },
});

const runs = [
  { name: "with Elwood's view held back", lag: true, observerThrows: false },
  { name: "live, with a status observer that throws", lag: false, observerThrows: true },
] as const;

for (const run of runs) {
  test(`C-ATTN-10 a message sent at a turn's ready is not taken by its offer, ${run.name}`, {
    skip: skipIf(skipReason("claude"), skipTurns),
    timeout: 240_000,
  }, async (t) => {
    seedOffer();
    answered = outputMatcher(/Yes✔/);
    setupStep = outputMatcher(/Spacetotoggle/);
    offerAnswered = false;
    setupOpened = false;
    const project = makeProject("claude");
    let session: ClaudeSessionApi | undefined;
    try {
      session = await startClaude(offerSessionOptions(project, "Offer At Ready"));
      const live = session;
      const observed = observeSession(live);
      await waitFor(() => (live.status === "ready" ? true : undefined), "initial ready", 120_000);
      if (run.lag)
        live.on("hook", (hook) => {
          if (hook.hook_event_name === "Stop") held?.hold(lagMs);
        });
      await live.sendMessage("Reply with exactly OK.");
      await waitFor(() => (live.status === "running" ? true : undefined), "turn running", 30_000);
      if (run.observerThrows)
        live.on("status", ({ status }) => {
          if (status === "ready") throw new Error("status observer failed");
        });
      const marker = `zq${Date.now().toString(36)}`;
      let sending: Promise<void> | undefined;
      const stopSending = live.on("status", ({ status }) => {
        if (status !== "ready" || sending) return;
        sending = live.sendMessage(`Check ${marker}.\nReply with exactly OK. Do not use tools.`);
        // Teardown rejects a still-held send if an assertion below fails first.
        void sending.catch(() => undefined);
      });
      await waitFor(() => hookNamed(observed.hooks, "Stop"), "turn Stop", 90_000);
      stopSending();
      assert.ok(sending, "the message was sent at the turn's ready");
      if (!(await offerShown(live))) {
        skipNow(t, `Claude did not offer auto-mode setup:\n${live.terminal.snapshot().text}`);
        return;
      }
      const hooksBefore = observed.hooks.length;

      const submissions = () =>
        observed.hooks.filter(
          (hook) => hook.hook_event_name === "UserPromptSubmit" && hook.prompt.includes(marker),
        ).length;
      await waitFor(() => (submissions() > 0 ? true : undefined), "the sent message", 30_000);
      await waitFor(() => hookNamed(observed.hooks.slice(hooksBefore), "Stop"), "its Stop", 90_000);
      await sending;
      await delay(settleMs);
      assert.equal(submissions(), 1, "the message is submitted exactly once");
      assert.equal(offerAnswered, false, "the offer's Yes was never chosen");
      assert.equal(setupOpened, false, "no setup step opened");
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
}
