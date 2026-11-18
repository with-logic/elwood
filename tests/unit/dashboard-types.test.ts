/** Verify the public dashboard fields' adapter and event types (C-STATS-01/02). */
import { expectTypeOf, test } from "vitest";
import type { ClaudeTranscriptEvent } from "../../src/claude/transcript/emit.ts";
import type { ClaudeTokenUsage, CodexTokenUsage, ElwoodActivityEvent } from "../../src/index.ts";

test("C-STATS-01 C-STATS-02 dashboard observations narrow with their native sources", () => {
  const base = { elwoodSessionId: "s", kind: "other", label: "sample" } as const;
  const quotas = { primary: { usedPercent: 25, remainingPercent: 75 } };
  const subagent = { id: "worker", type: "reviewer", state: "started" } as const;
  // @ts-expect-error Claude does not report Codex quota.
  const claudeQuota: ElwoodActivityEvent = {
    ...base,
    agent: "claude",
    source: "transcript",
    transcriptPath: "/claude.jsonl",
    rateLimits: quotas,
  };
  // @ts-expect-error A quota snapshot must come from its native transcript path.
  const missingPath: ElwoodActivityEvent = {
    ...base,
    agent: "codex",
    source: "transcript",
    rateLimits: quotas,
  };
  // @ts-expect-error Subagent state is emitted with settled hook results only.
  const hookRequest: ElwoodActivityEvent = {
    ...base,
    kind: "hook",
    agent: "codex",
    source: "hook",
    subagent,
  };
  void [claudeQuota, missingPath, hookRequest];

  type CodexTranscript = Extract<ElwoodActivityEvent, { agent: "codex"; source: "transcript" }>;
  type ClaudeTranscript = Extract<ElwoodActivityEvent, { agent: "claude"; source: "transcript" }>;
  expectTypeOf<CodexTranscript["tokenUsage"]>().toEqualTypeOf<CodexTokenUsage | undefined>();
  expectTypeOf<ClaudeTranscript["tokenUsage"]>().toEqualTypeOf<ClaudeTokenUsage | undefined>();
});

test("C-STATS-01 a Claude usage-only transcript event requires its counters", () => {
  // @ts-expect-error A token_usage summary must carry response usage.
  const missingUsage: ClaudeTranscriptEvent = {
    elwoodSessionId: "s",
    path: "/claude.jsonl",
    item: {},
    summary: { kind: "other", label: "token_usage" },
  };
  void missingUsage;
});
