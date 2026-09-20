/** Attention diagnostic updates traverse the real status engine (PRD §5.3, C-ATTN-03). */
import { expect, test } from "vitest";
import { claudeScreenFactTableForTrustPolicy } from "../../src/claude/screen-table.ts";
import { codexScreenFactTableForTrustPolicy } from "../../src/codex/screen-table.ts";
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";
import { AttentionWatcher } from "../../src/core/attention.ts";
import { observeRenderedFrame, observeRenderedReading } from "../../src/core/rendered-observers.ts";
import { readScreenFacts, type ScreenFactTable } from "../../src/core/screen-facts.ts";
import { TurnStateWatcher } from "../../src/core/turn-state.ts";
import type { ElwoodSessionStatus, ElwoodStatusEvidence } from "../../src/core/types.ts";
import { SessionStatusEngine } from "../../src/runtime/status-evidence.ts";

function harness(table: ScreenFactTable = { agent: "codex", verifiedAgainst: "test", rules: [] }) {
  const activities: ElwoodActivityEvent[] = [];
  const submitted: ElwoodStatusEvidence[] = [];
  const statuses: ElwoodSessionStatus[] = [];
  const engine = new SessionStatusEngine({
    onReady: () => {},
    emitStatus: (status) => statuses.push(status),
    queueRunning: () => {},
    queueReady: () => {},
    queueBlocked: () => {},
    queueClose: () => {},
    cleanup: () => {},
  });
  const session = {
    get status() {
      return engine.status;
    },
    submitEvidence: (kind: ElwoodStatusEvidence) => {
      submitted.push(kind);
      return engine.submit(kind);
    },
  };
  const observers = {
    table,
    agent: table.agent,
    elwoodSessionId: "s1",
    turn: new TurnStateWatcher(),
    attention: new AttentionWatcher(),
    emitActivity: (event: ElwoodActivityEvent) => activities.push(event),
  };
  const observe = (ids: readonly string[]) => {
    const reading = readScreenFacts(
      {
        ...table,
        rules: ids.map((id) => ({
          id,
          fact: "blocking_prompt_visible" as const,
          all: [/dialog/],
        })),
      },
      { text: "dialog", title: "" },
    );
    observeRenderedReading(observers, reading, session);
  };
  const frame = (text: string) => observeRenderedFrame(observers, { text, title: "" }, session);
  return { engine, observe, frame, activities, statuses, submitted };
}

test("C-ATTN-03 emits a replacement label while the real session remains blocked", () => {
  const { engine, observe, activities, statuses, submitted } = harness();
  engine.submit("startup_usable");
  observe(["codex-update-prompt"]);
  observe(["codex-unidentified-dialog"]);
  observe(["codex-unidentified-dialog"]);
  expect(engine.status).toBe("blocked");
  expect(statuses).toEqual(["running", "blocked"]);
  expect(submitted).toEqual(["blocking_prompt_shown"]);
  expect(activities.map((event) => event.label)).toEqual([
    "codex-update-prompt",
    "codex-unidentified-dialog",
  ]);
  observe([]);
  expect(engine.status).toBe("ready");
  expect(activities).toHaveLength(2);
});

test.each([
  "starting",
  "exited",
] as const)("C-ATTN-03 suppresses changed attention labels while %s", (status) => {
  const { engine, observe, activities } = harness();
  if (status === "exited") engine.submit("terminal_exited");
  observe(["codex-update-prompt"]);
  observe(["codex-unidentified-dialog"]);
  expect(engine.status).toBe(status);
  expect(activities).toEqual([]);
});

test.each([
  {
    agent: "codex",
    table: codexScreenFactTableForTrustPolicy(false),
    initial: "Update available! 0.153.3 -> 0.153.4\n› 1. Update now\n  2. Skip",
    replacement:
      "Would you like to run the following command?\n› 1. Yes\n  2. No\nPress enter to confirm or esc to cancel",
    labels: ["codex-update-prompt", "codex-approval-dialog"],
  },
  {
    agent: "claude",
    table: claudeScreenFactTableForTrustPolicy(false),
    initial: "Do you want to create elwood.txt?\n❯ 1. Yes\n  3. No\nEsc to cancel",
    replacement: "Switch model?\n❯ Yes, switch to Sonnet\nNo, go back",
    labels: ["claude-permission-dialog", "claude-model-switch-confirmation"],
  },
])("C-ATTN-03 $agent production facts report replacements without another status decision", ({
  table,
  initial,
  replacement,
  labels,
}) => {
  const { engine, frame, activities, submitted } = harness(table);
  engine.submit("startup_usable");
  frame(initial);
  frame(initial);
  frame(replacement);
  frame(replacement);
  expect(engine.status).toBe("blocked");
  expect(activities.map((event) => event.label)).toEqual(labels);
  expect(submitted).toEqual(["blocking_prompt_shown"]);
});
