/** Coordinate native workspace trust list proof and its session lifetime (PRD §5.13, C-ATTN-07). */
import { onNativeRenderEvidenceInvalidated, settledNativeSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import type { ElwoodAgentKind } from "../activity/index.ts";
import { boundedTrustEvidence } from "../trust/evidence-deadline.ts";
import type { TrustPromptId } from "../trust/prompts.ts";
import type { ElwoodDialogRequest } from "./types.ts";

export type VerifiedWorkspaceTrust<Agent extends ElwoodAgentKind> = {
  readonly frame: TerminalSnapshot;
  readonly request: ElwoodDialogRequest<Agent>;
};

type Checked<Agent extends ElwoodAgentKind> = VerifiedWorkspaceTrust<Agent> | undefined;
type NativeTrustView = {
  readonly terminal: () => ElwoodTerminal;
  readonly humanOwnedPrompt: () => TrustPromptId | undefined;
};

// One already-issued filesystem operation may outlive its deadline. Allow a newer
// frame to be checked while that operation finishes, with a bound on stranded work.
const maxUnfinishedLookups = 2;

export class WorkspaceTrustPolling<Agent extends ElwoodAgentKind> {
  private readonly controller = new AbortController();
  private pending:
    | { readonly frame: TerminalSnapshot; readonly result: Promise<Checked<Agent>> }
    | undefined;
  private unfinishedLookups = 0;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  bind(terminal: ElwoodTerminal, closing: AbortSignal, end: () => void): void {
    const offNative = onNativeRenderEvidenceInvalidated(terminal, end);
    closing.addEventListener(
      "abort",
      () => {
        offNative();
        end();
      },
      { once: true },
    );
  }

  end(): void {
    this.controller.abort();
  }

  isFrameCurrent(
    frame: TerminalSnapshot,
    { terminal, humanOwnedPrompt }: NativeTrustView,
  ): boolean {
    return (
      !this.signal.aborted &&
      humanOwnedPrompt() === "workspace_trust" &&
      settledNativeSnapshot(terminal()) === frame
    );
  }

  read(
    frame: TerminalSnapshot,
    revalidate: (signal: AbortSignal) => Promise<boolean>,
    accept: (proved: boolean | undefined) => Checked<Agent>,
  ): Promise<Checked<Agent>> | undefined {
    // Never queue the current frame behind an obsolete lookup and a second deadline.
    if (this.pending) return this.pending.frame === frame ? this.pending.result : undefined;
    if (this.unfinishedLookups >= maxUnfinishedLookups) return undefined;

    const result = boundedTrustEvidence(async (signal) => {
      this.unfinishedLookups++;
      try {
        return await revalidate(signal);
      } finally {
        this.unfinishedLookups--;
      }
    }, this.signal)
      .then(accept)
      .finally(() => {
        this.pending = undefined;
      });
    this.pending = { frame, result };
    return result;
  }
}
