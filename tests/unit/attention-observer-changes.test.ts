/** Attention diagnostic updates traverse the real status engine (PRD §5.3, C-ATTN-03). */
import { expect, test } from "vitest";
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";
import { AttentionWatcher } from "../../src/core/attention.ts";
import { observeRenderedReading } from "../../src/core/rendered-observers.ts";
import { readScreenFacts, type ScreenFactTable } from "../../src/core/screen-facts.ts";
import { TurnStateWatcher } from "../../src/core/turn-state.ts";
import type { ElwoodSessionStatus, ElwoodStatusEvidence } from "../../src/core/types.ts";
import { SessionStatusEngine } from "../../src/runtime/status-evidence.ts";

function harness() {
  const activities: ElwoodActivityEvent[] = [];
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
    submitEvidence: (kind: ElwoodStatusEvidence) => engine.submit(kind),
  };
  const table: ScreenFactTable = { agent: "codex", verifiedAgainst: "test", rules: [] };
  const observers = {
    table,
    agent: "codex" as const,
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
  return { engine, observe, activities, statuses };
}

test("C-ATTN-03 emits a replacement label while the real session remains blocked", () => {
  const { engine, observe, activities, statuses } = harness();
  engine.submit("startup_usable");
  observe(["codex-update-prompt"]);
  observe(["codex-unidentified-dialog"]);
  observe(["codex-unidentified-dialog"]);
  expect(engine.status).toBe("blocked");
  expect(statuses).toEqual(["running", "blocked"]);
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
