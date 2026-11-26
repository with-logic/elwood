/** Coordinate workspace trust proof and its lifetime (PRD §5.13, C-ATTN-07, C-ATTN-08). */
import { onNativeRenderEvidenceInvalidated, settledNativeSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import type { ElwoodAgentKind } from "../activity/index.ts";
import { boundedTrustEvidence } from "../trust/evidence-deadline.ts";
import type { TrustPromptId } from "../trust/prompts.ts";
import type { WorkspaceTrustDialogRequest } from "./types.ts";
import { createWorkspaceTrustRequest, type WorkspaceTrustMenu } from "./workspace-trust-request.ts";

export type VerifiedWorkspaceTrust<Agent extends ElwoodAgentKind> = {
  readonly frame: TerminalSnapshot;
  readonly request: WorkspaceTrustDialogRequest<Agent>;
};

type Checked<Agent extends ElwoodAgentKind> = VerifiedWorkspaceTrust<Agent> | undefined;
type NativeTrustView = {
  readonly terminal: () => ElwoodTerminal;
  readonly humanOwnedPrompt: () => TrustPromptId | undefined;
};

type TrustFrame<Agent extends ElwoodAgentKind> = {
  readonly frame: TerminalSnapshot;
  readonly identity: string;
  readonly menu: WorkspaceTrustMenu<Agent>;
};

// One already-issued filesystem operation may outlive its deadline. Allow a newer
// frame to be checked while that operation finishes, with a bound on stranded work.
const maxUnfinishedLookups = 2;

export class WorkspaceTrustPolling<
  Agent extends ElwoodAgentKind,
  Candidate extends TrustFrame<Agent> = TrustFrame<Agent>,
> {
  private sampled:
    | { readonly frame: TerminalSnapshot; readonly candidate: Candidate | undefined }
    | undefined;
  private open:
    | { readonly identity: string; readonly request: WorkspaceTrustDialogRequest<Agent> }
    | undefined;

  private readonly controller = new AbortController();
  private pending:
    | {
        readonly frame: TerminalSnapshot;
        readonly generation: number;
        readonly result: Promise<Checked<Agent>>;
      }
    | undefined;
  private unfinishedLookups = 0;
  private resumeWhenAvailable: (() => void) | undefined;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get currentRequest(): WorkspaceTrustDialogRequest<Agent> | undefined {
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
    elwoodSessionId: string,
    { frame, identity, menu }: Candidate,
  ): VerifiedWorkspaceTrust<Agent> {
    if (this.open?.identity !== identity) {
      this.open = { identity, request: createWorkspaceTrustRequest(elwoodSessionId, menu) };
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
    this.resumeWhenAvailable = undefined;
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
    generation = 0,
  ): Promise<Checked<Agent>> | undefined {
    // Never queue the current frame behind an obsolete lookup and a second deadline.
    if (this.pending?.generation === generation)
      return this.pending.frame === frame ? this.pending.result : undefined;
    const proof = this.collect(revalidate);
    if (!proof) return undefined;
    const result = proof.then(accept).finally(() => {
      if (this.pending?.result === result) this.pending = undefined;
    });
    this.pending = { frame, generation, result };
    return result;
  }

  /** Independently requested proofs share the allowance for unfinished native reads. */
  collect(
    revalidate: (signal: AbortSignal) => Promise<boolean>,
    audience?: AbortSignal,
    onAvailable?: () => void,
  ): Promise<boolean | undefined> | undefined {
    if (this.unfinishedLookups >= maxUnfinishedLookups) {
      // A waiting caller can retry once a submitted native read finishes.
      this.resumeWhenAvailable = onAvailable ?? this.resumeWhenAvailable;
      return undefined;
    }
    const cancellation = audience ? AbortSignal.any([this.signal, audience]) : this.signal;
    return boundedTrustEvidence(async (signal) => {
      this.unfinishedLookups++;
      try {
        return await revalidate(signal);
      } finally {
        this.unfinishedLookups--;
        const resume = this.resumeWhenAvailable;
        this.resumeWhenAvailable = undefined;
        resume?.();
      }
    }, cancellation);
  }
}
