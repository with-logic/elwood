/** List Claude's human-owned workspace trust menu with settled native and Git evidence (C-ATTN-07). */
import { randomUUID } from "node:crypto";
import type { ElwoodDialogRequest } from "../../core/dialogs/types.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { boundedTrustEvidence } from "../../core/trust/evidence-deadline.ts";
import type { TrustPromptIdFor } from "../../core/trust/prompts.ts";
import { onNativeRenderEvidenceInvalidated, settledNativeSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import { matchClaudeWorkspaceTrustFrame, type WorkspaceTrustFrame } from "./menu.ts";
import type { ClaudeLaunchTrustEvidence } from "./target.ts";

type DialogRequest = ElwoodDialogRequest<"claude">;
type Open = { readonly identity: string; readonly request: DialogRequest };
type VerifiedWorkspaceTrust = {
  readonly frame: TerminalSnapshot;
  readonly request: DialogRequest;
};
type Verification = {
  readonly frame: TerminalSnapshot;
  readonly result: Promise<VerifiedWorkspaceTrust | undefined>;
};
type DiscoveryInput = {
  readonly elwoodSessionId: string;
  readonly evidence: ClaudeLaunchTrustEvidence | undefined;
  readonly terminal: () => ElwoodTerminal;
  readonly humanOwnedPrompt: () => TrustPromptIdFor<"claude"> | undefined;
  readonly clearance: TrustClearance;
};

export class ClaudeWorkspaceTrustDiscovery {
  private open: Open | undefined;
  private candidate: WorkspaceTrustFrame | undefined;
  private checking: Verification | undefined;
  private readonly lifetime = new AbortController();
  private readonly input: DiscoveryInput;
  private readonly match: ReturnType<typeof matchClaudeWorkspaceTrustFrame> | undefined;

  constructor(input: DiscoveryInput) {
    this.input = input;
    this.match =
      input.evidence && matchClaudeWorkspaceTrustFrame(input.evidence, input.humanOwnedPrompt);
  }

  bind(terminal: ElwoodTerminal, closing: AbortSignal): void {
    const offNative = onNativeRenderEvidenceInvalidated(terminal, () => this.endStartup());
    closing.addEventListener(
      "abort",
      () => {
        offNative();
        this.endStartup();
      },
      { once: true },
    );
  }

  endStartup(): void {
    this.lifetime.abort();
    this.candidate = undefined;
    this.open = undefined;
  }

  async list(): Promise<readonly DialogRequest[]> {
    const verified = await this.read();
    return verified && this.isCurrent(verified) ? [verified.request] : [];
  }

  /** Track settled menu changes between polls without consulting the filesystem. */
  reconcile(): WorkspaceTrustFrame | undefined {
    if (this.lifetime.signal.aborted || !this.match) return undefined;
    const terminal = this.input.terminal();
    const frame = settledNativeSnapshot(terminal);
    if (!frame) return undefined;
    if (this.input.clearance(frame.text)) {
      this.endStartup();
      return undefined;
    }
    const candidate =
      this.candidate?.frame === frame && this.input.humanOwnedPrompt() === "workspace_trust"
        ? this.candidate
        : this.match(terminal, frame);
    this.candidate = candidate;
    if (!candidate || (this.open && this.open.identity !== candidate.identity))
      this.open = undefined;
    return candidate;
  }

  private async read(): Promise<VerifiedWorkspaceTrust | undefined> {
    const candidate = this.reconcile();
    if (!candidate) return undefined;
    if (this.checking) {
      return this.checking.frame === candidate.frame ? await this.checking.result : undefined;
    }
    const result = this.verify(candidate).finally(() => {
      this.checking = undefined;
    });
    this.checking = { frame: candidate.frame, result };
    return await result;
  }

  private async verify({ frame, menu, identity, verifyTarget }: WorkspaceTrustFrame) {
    const proved = await boundedTrustEvidence(verifyTarget, this.lifetime.signal);
    if (proved === false) this.endStartup();
    if (!this.isFrameCurrent(frame)) return undefined;
    if (proved === undefined) {
      this.endStartup();
      return undefined;
    }

    if (this.open?.identity !== identity) {
      const request: DialogRequest = Object.freeze({
        id: randomUUID(),
        elwoodSessionId: this.input.elwoodSessionId,
        agent: "claude",
        kind: "trust",
        label: "workspace_trust",
        ...menu.target,
        text: menu.dialog.header,
        choices: Object.freeze(
          menu.dialog.options.map(({ label }) => Object.freeze({ id: randomUUID(), label })),
        ),
      });
      this.open = { identity, request };
    }
    return { frame, request: this.open.request };
  }

  private isCurrent({ frame, request }: VerifiedWorkspaceTrust): boolean {
    return this.open?.request === request && this.isFrameCurrent(frame);
  }

  private isFrameCurrent(frame: TerminalSnapshot): boolean {
    return (
      !this.lifetime.signal.aborted &&
      this.input.humanOwnedPrompt() === "workspace_trust" &&
      settledNativeSnapshot(this.input.terminal()) === frame
    );
  }
}
