/** Verify Claude workspace trust before dispatching each native key (C-ATTN-07). */
import type { WorkspaceTrustPolling } from "../../core/dialogs/workspace-trust-polling.ts";
import type { TerminalSnapshot } from "../../terminal/headless.ts";
import type { WorkspaceTrustFrame } from "./menu.ts";

type AnswerProof = {
  readonly candidate: WorkspaceTrustFrame;
  readonly signal: AbortSignal;
  readonly polling: WorkspaceTrustPolling<"claude", WorkspaceTrustFrame>;
  readonly revision: () => number;
  readonly canUseFrame: (frame: TerminalSnapshot) => boolean;
  readonly scopeLost: (frame: TerminalSnapshot, result: boolean | undefined) => void;
  readonly revoke: () => void;
};

export async function verifyClaudeTrustAnswer({
  candidate,
  signal,
  polling,
  revision,
  canUseFrame,
  scopeLost,
  revoke,
}: AnswerProof): Promise<(() => boolean) | undefined> {
  // Let every synchronous dialog listener return before collecting launch evidence.
  await Promise.resolve();
  if (signal.aborted || !canUseFrame(candidate.frame)) return undefined;
  const generation = revision();
  const checking = polling.collect(candidate.revalidateLaunchEvidence, signal);
  if (!checking) return undefined;
  const verified = await checking.catch(() => "rejected" as const);
  if (signal.aborted || polling.signal.aborted) return undefined;
  if (verified === "rejected") {
    revoke();
    return undefined;
  }
  scopeLost(candidate.frame, verified);
  return verified === true ? () => generation === revision() : undefined;
}
