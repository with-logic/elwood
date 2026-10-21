/** Required transcript payloads survive activity normalization (PRD §5.4, C-CODEX-22). */
import { expect, test } from "vitest";
import type { CodexTranscriptSummary } from "../../src/codex/transcript/types.ts";
import { activityFromClaudeTranscript } from "../../src/core/activity/index.ts";
import type { ElwoodActivityEvent } from "../../src/index.ts";

test("C-CODEX-22 progress and commentary types require their documented identity and text", () => {
  const base = {
    elwoodSessionId: "s",
    kind: "assistant_progress",
    agent: "codex",
    source: "transcript",
    label: "assistant",
  } as const;
  type Progress = Extract<ElwoodActivityEvent, { readonly kind: "assistant_progress" }>;
  const progress: Progress = { ...base, text: "Working", transcriptPath: "/codex.jsonl", raw: {} };
  // @ts-expect-error Progress must identify its transcript path.
  const missingPath: Progress = { ...base, text: "Working", raw: {} };
  // @ts-expect-error Progress must include the raw source item, even when its value is unknown.
  const missingRaw: Progress = { ...base, text: "Working", transcriptPath: "/codex.jsonl" };
  // @ts-expect-error Progress must contain readable text.
  const missingText: Progress = { ...base, transcriptPath: "/codex.jsonl", raw: {} };
  // @ts-expect-error Progress is produced by Codex, not Claude.
  const wrongAgent: Progress = { ...progress, agent: "claude" };
  // @ts-expect-error Progress comes from committed transcript records.
  const wrongSource: Progress = { ...progress, source: "terminal" };
  // @ts-expect-error Progress has the assistant role label.
  const wrongLabel: Progress = { ...progress, label: "user" };
  const commentary = { kind: "commentary", label: "assistant", text: "Working" } as const;
  // @ts-expect-error Commentary summaries also require readable text.
  const missingSummaryText: CodexTranscriptSummary = { kind: "commentary", label: "assistant" };
  // @ts-expect-error Commentary can only describe assistant messages.
  const wrongSummaryLabel: CodexTranscriptSummary = { ...commentary, label: "user" };
  void [
    missingText,
    missingPath,
    missingRaw,
    wrongAgent,
    wrongSource,
    wrongLabel,
    missingSummaryText,
    wrongSummaryLabel,
  ];
  const transcriptPath: string = progress.transcriptPath;
  expect(transcriptPath).toBe("/codex.jsonl");
  expect(progress.text).toBe(commentary.text);
});

test("C-CLAUDE-15 normalized Claude transcript variants retain required payloads", () => {
  type Projection = ReturnType<typeof activityFromClaudeTranscript>;
  const base = { elwoodSessionId: "s", agent: "claude", source: "transcript", label: "a" } as const;
  // @ts-expect-error Projected assistant messages require text.
  const missingText: Projection = { ...base, kind: "assistant_message" };
  // @ts-expect-error Projected reasoning requires text.
  const missingReasoning: Projection = { ...base, kind: "reasoning" };
  // @ts-expect-error Projected tool calls require a tool name.
  const missingName: Projection = { ...base, kind: "tool_call" };
  // @ts-expect-error Projected tool results require a correlating tool-use ID.
  const missingId: Projection = { ...base, kind: "tool_result" };
  void [missingText, missingReasoning, missingName, missingId];
  const message = activityFromClaudeTranscript({
    elwoodSessionId: "s",
    path: "/transcript.jsonl",
    item: {},
    summary: { kind: "assistant_message", label: "assistant", text: "Done" },
  });
  if (message.kind === "assistant_message") {
    const text: string = message.text;
    expect(text).toBe("Done");
  } else {
    throw new Error("Expected the assistant-message projection");
  }
});

test("Codex summaries exclude unsurfaced prose and require fixed message and reasoning labels", () => {
  // @ts-expect-error Unsurfaced summaries never contain readable text.
  const otherText: CodexTranscriptSummary = {
    kind: "other",
    label: "agent_message",
    text: "hidden",
  };
  // @ts-expect-error Final messages have the validated assistant role.
  const wrongMessageLabel: CodexTranscriptSummary = { kind: "message", label: "user" };
  // @ts-expect-error Reasoning summaries have their fixed reasoning label.
  const wrongReasoningLabel: CodexTranscriptSummary = { kind: "reasoning", label: "analysis" };
  void [otherText, wrongMessageLabel, wrongReasoningLabel];
});
