/** Real private registry and native observations for PRD §4 candidate tests. */
import { vi } from "vitest";
import { CodexQuestionCandidates } from "../../../src/codex/questions/candidates.ts";
import { questionMetadataLimitBytes } from "../../../src/codex/questions/limits.ts";
import type { ElwoodActivityEvent } from "../../../src/core/activity/index.ts";
import { QuestionRegistry } from "../../../src/core/questions/registry.ts";
import { activity } from "../../helpers/activity.ts";

export function event(payload: unknown): ElwoodActivityEvent & { readonly kind: "other" } {
  return {
    ...activity({
      elwoodSessionId: "session",
      agent: "codex",
      source: "transcript",
      label: "native",
      raw: { payload },
    }),
    kind: "other",
  };
}
type CallOptions = {
  readonly id?: string;
  readonly queued?: boolean;
  readonly accepted?: boolean;
  readonly prompt?: string;
};
export function call({
  id = "call",
  queued = true,
  accepted = false,
  prompt = "Pick",
}: CallOptions = {}): unknown {
  const questions = queued
    ? [{ title: prompt, options: ["Yes"] }]
    : [{ id: "q", question: prompt, options: [{ label: "Yes" }] }];
  return accepted
    ? { type: "AgentMessage", id, delivery: "async", questions }
    : {
        type: "function_call",
        call_id: id,
        name: queued ? "request_user_input_async" : "request_user_input",
        arguments: JSON.stringify({ questions }),
      };
}
export function setup(throws = false) {
  const listener = vi.fn(() => {
    if (throws) throw new Error("observer");
  });
  const registry = new QuestionRegistry("codex", "session", {
    emit: listener,
  });
  const disabled = vi.fn();
  return { registry, listener, disabled, state: new CodexQuestionCandidates(registry, disabled) };
}

/** The prompt fills the metadata limit; its serialized JSON envelope exceeds it. */
export function overflowingMetadataCall(): unknown {
  return call({ id: "large", prompt: "x".repeat(questionMetadataLimitBytes) });
}
