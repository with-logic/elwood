/** Speed evidence retains source/adapter identity and the standard tier. C-SPEED-02/03. */
import { expect, expectTypeOf, test } from "vitest";
import type { claudeSpeedObservation } from "../../src/claude/transcript/speed.ts";
import type { codexSpeedObservation } from "../../src/codex/transcript/speed.ts";
import type {
  AgentSpeedObservation,
  CodexServiceTiers,
  ElwoodActivityEvent,
} from "../../src/index.ts";

test("C-SPEED-03 only the matching transcript adapter can carry speed evidence", () => {
  const event = {
    elwoodSessionId: "s",
    agent: "codex",
    source: "transcript",
    kind: "other",
    label: "turn",
    speed: { agent: "codex", serviceTier: "fast", evidence: "turn_configuration" },
  } as const satisfies ElwoodActivityEvent;
  // @ts-expect-error Hook events cannot claim transcript speed evidence.
  const hook: ElwoodActivityEvent = { ...event, source: "hook" };
  // @ts-expect-error The outer and nested adapter identities must agree.
  const crossed: ElwoodActivityEvent = { ...event, agent: "claude" };
  const claude = {
    ...event,
    agent: "claude",
    speed: { agent: "claude", fastMode: true, evidence: "response_usage" },
  } as const satisfies ElwoodActivityEvent;
  // @ts-expect-error Terminal events cannot claim response usage.
  const terminal: ElwoodActivityEvent = { ...claude, source: "terminal" };
  // @ts-expect-error Codex cannot carry Claude response usage.
  const crossedClaude: ElwoodActivityEvent = { ...claude, agent: "codex" };
  void [hook, crossed, terminal, crossedClaude];
  expect(event.speed.serviceTier).toBe("fast");
  expectTypeOf<ReturnType<typeof codexSpeedObservation>["speed"]>().toEqualTypeOf<
    Extract<AgentSpeedObservation, { agent: "codex" }> | undefined
  >();
  expectTypeOf<ReturnType<typeof claudeSpeedObservation>["speed"]>().toEqualTypeOf<
    Extract<AgentSpeedObservation, { agent: "claude" }> | undefined
  >();
});

test("C-SPEED-02 model capabilities always start with the standard tier", () => {
  const standard: CodexServiceTiers = { fetchedAt: "2026-11-16", values: ["default"] };
  // @ts-expect-error The native catalog always includes standard speed.
  const empty: CodexServiceTiers = { ...standard, values: [] };
  // @ts-expect-error Accelerated tiers cannot replace the required standard entry.
  const acceleratedOnly: CodexServiceTiers = { ...standard, values: ["fast"] };
  void [empty, acceleratedOnly];
  expectTypeOf(standard.values[0]).toEqualTypeOf<"default">();
});
