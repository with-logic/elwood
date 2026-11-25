/** Coordinate native workspace trust list proof and its session lifetime (PRD §5.13, C-ATTN-07). */
import { onNativeRenderEvidenceInvalidated, settledNativeSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import type { ElwoodAgentKind } from "../activity/index.ts";
import { boundedTrustEvidence } from "../trust/evidence-deadline.ts";
import type { TrustPromptId } from "../trust/prompts.ts";
import type { ElwoodDialogRequest } from "./types.ts";
import { createWorkspaceTrustRequest, type WorkspaceTrustMenu } from "./workspace-trust-request.ts";

export type VerifiedWorkspaceTrust<Agent extends ElwoodAgentKind> = {
  readonly frame: TerminalSnapshot;
  readonly request: ElwoodDialogRequest<Agent>;
};

type Checked<Agent extends ElwoodAgentKind> = VerifiedWorkspaceTrust<Agent> | undefined;
type NativeTrustView = {
  readonly terminal: () => ElwoodTerminal;
  readonly humanOwnedPrompt: () => TrustPromptId | undefined;
};

type TrustFrame = {
  readonly frame: TerminalSnapshot;
  readonly identity: string;
  readonly menu: WorkspaceTrustMenu;
};

// One already-issued filesystem operation may outlive its deadline. Allow a newer
// frame to be checked while that operation finishes, with a bound on stranded work.
const maxUnfinishedLookups = 2;

export class WorkspaceTrustPolling<
  Agent extends ElwoodAgentKind,
  Candidate extends TrustFrame = TrustFrame,
> {
  private sampled:
    | { readonly frame: TerminalSnapshot; readonly candidate: Candidate | undefined }
    | undefined;
  private open:
    | { readonly identity: string; readonly request: ElwoodDialogRequest<Agent> }
    | undefined;

  private readonly controller = new AbortController();
  private pending:
    | { readonly frame: TerminalSnapshot; readonly result: Promise<Checked<Agent>> }
    | undefined;
  private unfinishedLookups = 0;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get currentRequest(): ElwoodDialogRequest<Agent> | undefined {
    return this.open?.request;
  }

  sample(
    terminal: ElwoodTerminal,
    frame: TerminalSnapshot,
    match: (terminal: ElwoodTerminal, frame: TerminalSnapshot) => Candidate | undefined,
  ): Candidate | undefined {
    if (this.sampled?.frame !== frame) this.sampled = { frame, candidate: match(terminal, frame) };
    const { candidate } = this.sampled;
    if (this.open?.identity !== candidate?.identity) this.retire();
    return candidate;
  }

  acceptVerified(
    agent: Agent,
    elwoodSessionId: string,
    { frame, identity, menu }: Candidate,
  ): VerifiedWorkspaceTrust<Agent> {
    if (this.open?.identity !== identity) {
      this.open = { identity, request: createWorkspaceTrustRequest(agent, elwoodSessionId, menu) };
    }
    return { frame, request: this.open.request };
  }

  retire(): void {
    this.open = undefined;
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
    this.sampled = undefined;
    this.retire();
  }

  canUseTrustFrame(
    frame: TerminalSnapshot,
    { terminal, humanOwnedPrompt }: NativeTrustView,
  ): boolean {
    return (
      !this.signal.aborted &&
      humanOwnedPrompt() === "workspace_trust" &&
      settledNativeSnapshot(terminal()) === frame
    );
  }

  /** Skip if another frame or the work bound prevents a check. A completed
   * mismatch is false, while expiry or cancellation is undefined. The caller
   * reconciles that result even if the checked frame has been superseded. */
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
