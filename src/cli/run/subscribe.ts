/**
 * Session event wiring shared by the headless run and model-listing executors:
 * blocked-prompt classification, Codex update-prompt attention, status, warnings,
 * premature exit, and optional raw-frame mirroring.
 * Implements PRD §12A.2/§12A.10 and C-CLI-05/C-CLI-09/C-CLI-26.
 */

import { blockingTrustSpecs, trustPromptAllowlist } from "../../core/trust/prompts.ts";
import type { ElwoodSessionStatus } from "../../core/types.ts";
import type { ElwoodWarningEvent } from "../../core/warnings/index.ts";
import type { HeadedDisplay } from "../head/display.ts";
import type { CliLifecycle } from "../lifecycle/index.ts";
import type { CliSessionFacade } from "../session/index.ts";
import type { EffectiveRunRequest } from "../types.ts";
import type { CodexUpdateAttentionGuard } from "../update-attention.ts";

export type RunEventObserver = {
  readonly status: (status: ElwoodSessionStatus) => void;
  readonly warning: (event: ElwoodWarningEvent) => void;
};

export function subscribeRunEvents(
  request: EffectiveRunRequest,
  session: CliSessionFacade,
  lifecycle: CliLifecycle,
  observer: RunEventObserver,
  head: HeadedDisplay | undefined,
  updateAttention: CodexUpdateAttentionGuard | undefined,
): readonly (() => void)[] {
  const common = [
    session.on("activity", (event) => {
      if (event.kind === "attention" && event.label === "codex-update-prompt") {
        if (updateAttention === undefined) lifecycle.block(event.label);
        else updateAttention.attention(event.promptGeneration);
      } else if (event.kind === "attention" && attentionNeedsHuman(request, event.label)) {
        lifecycle.block(event.label);
      }
      if (event.kind === "startup_prompt" && event.label === "update") {
        updateAttention?.succeeded();
      }
    }),
    session.on("status", ({ status }) => {
      updateAttention?.status(status);
      observer.status(status);
    }),
    session.on("warning", (event) => {
      if (
        event.code === "startup_prompt_write_failed" &&
        event.agent === "codex" &&
        event.label === "update"
      ) {
        updateAttention?.writeFailed();
      }
      observer.warning(event);
    }),
    session.on("terminal:exit", () => lifecycle.agentExited()),
  ];
  return head === undefined
    ? common
    : [...common, session.on("terminal:data", ({ data }) => head.write(data))];
}

function attentionNeedsHuman(request: EffectiveRunRequest, label: string): boolean {
  const matches = (prompt: (typeof trustPromptAllowlist)[number]) =>
    prompt.agent === request.agent && prompt.id === label;
  return (
    !trustPromptAllowlist.some(matches) ||
    blockingTrustSpecs(request.agent, request.trust).some(matches)
  );
}
