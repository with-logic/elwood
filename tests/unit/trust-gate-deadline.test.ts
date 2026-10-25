/** The trust budget is spent only while its gate is on screen (C-TRUST-01, C-ATTN-03). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeTrustClearance } from "../../src/claude/screen-table.ts";
import type { ElwoodAgentKind } from "../../src/core/activity/index.ts";
import { TrustPromptResponder, type TrustPromptResult } from "../../src/core/trust/responder.ts";
import {
  claudeComposer,
  claudeTrust,
  clearanceFor,
  codexComposer,
  codexTrust,
} from "../fixtures/trust-composer.ts";

/** Claude 2.1.310 after an accepted folder-trust answer, before its composer paints
 * (real PTY capture, path normalized): the screen stayed like this for up to 4 s. */
const claudeBootBanner = [
  " ▐▛███▛█   Claude Code v2.1.310",
  "▝▜██████▀  Opus 5.5 with high effort · Claude Max",
  " ▝▝   ▝▝   /tmp/ELWOOD_CAPTURE/project",
  "─".repeat(189),
].join("\n");
const agents = {
  claude: {
    gate: `${claudeTrust}\n1. Yes\n2. No`,
    boot: claudeBootBanner,
    composer: claudeComposer,
  },
  codex: {
    gate: `${codexTrust}\n› 1. Yes, continue\n  2. No, quit`,
    boot: "",
    composer: codexComposer,
  },
} as const satisfies Record<
  ElwoodAgentKind,
  { readonly gate: string; readonly boot: string; readonly composer: string }
>;
/** Every adapter must cover this shared coordinator test. */
const agentKinds = Object.keys(agents) as (keyof typeof agents)[];
const unsupported = "Do you trust this folder?\nNew native explanation\n1. Yes";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function settled<A extends ElwoodAgentKind>(result: TrustPromptResult<A>) {
  if (result?.kind !== "attempted") throw new Error("expected attempt");
  return result.settled;
}

test.each(
  agentKinds,
)("C-ATTN-03 %s: an answered gate that left the frame never blocks while the CLI boots", async (agent) => {
  const { gate, boot, composer } = agents[agent];
  const responder = new TrustPromptResponder(agent, clearanceFor(agent), true);
  let frame: string = gate;
  // The CLI erases its dialog on the answer, then takes seconds to paint its composer.
  const write = vi.fn(() => {
    frame = boot;
  });
  const attempt = settled(responder.handle(frame, write, () => frame));
  const outcomes: string[] = [];
  void attempt.then((outcome) => outcomes.push(outcome));
  await vi.advanceTimersByTimeAsync(250);
  expect(write).toHaveBeenCalledOnce();
  responder.handle(frame, write, () => frame);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(responder.blockedPrompt).toBeUndefined();
  // Clearance is still unverified: queued input stays held and the answer unreported.
  expect(responder.inputBlocking).toBe(true);
  expect(outcomes).toEqual([]);
  responder.handle(composer, write, () => composer);
  await expect(attempt).resolves.toBe("answered");
  expect(write).toHaveBeenCalledOnce();
  expect(responder.inputBlocking).toBe(false);
  expect(responder.blockedPrompt).toBeUndefined();
});

test("C-TRUST-01 the budget spends only on-screen time and resumes when the gate returns", async () => {
  const changed = vi.fn();
  const responder = new TrustPromptResponder("claude", claudeTrustClearance, true, changed);
  const write = vi.fn();
  responder.handle(unsupported, write);
  await vi.advanceTimersByTimeAsync(3_000);
  responder.handle("", write);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(responder.blockedPrompt).toBeUndefined();
  expect(responder.inputBlocking).toBe(true);
  // The same gate repaints: its remaining two seconds resume, not a fresh budget.
  responder.handle(unsupported, write);
  await vi.advanceTimersByTimeAsync(1_999);
  expect(changed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(responder.blockedPrompt).toBe("workspace_trust");
  expect(changed).toHaveBeenCalledOnce();
  expect(write).not.toHaveBeenCalled();
});

test("C-TRUST-01 a gate that keeps leaving and returning still exhausts one budget", async () => {
  const responder = new TrustPromptResponder("claude", claudeTrustClearance, true);
  for (let flicker = 0; flicker < 4; flicker++) {
    responder.handle(unsupported, vi.fn());
    await vi.advanceTimersByTimeAsync(1_000);
    responder.handle("", vi.fn());
    await vi.advanceTimersByTimeAsync(9_000);
  }
  expect(responder.blockedPrompt).toBeUndefined();
  responder.handle(unsupported, vi.fn());
  await vi.advanceTimersByTimeAsync(1_000);
  expect(responder.blockedPrompt).toBe("workspace_trust");
});
