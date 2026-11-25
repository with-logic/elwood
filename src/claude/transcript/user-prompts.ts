/** Match blank authenticated Claude hooks to committed user records (PRD §5.4). */
import { isAbsolute } from "node:path";
import type { UserPromptPresentation } from "../../core/activity/prompt-presentation.ts";
import { isRecord } from "../../core/predicates.ts";
import { claudePromptPresentation } from "../pasted-content.ts";
import type { InitialUserPrompt } from "./initial-prompt.ts";
import { maxIdentifierBytes, maxPathBytes } from "./turn-identity.ts";
import { type UserPromptRecord, userPromptRecord } from "./user-record.ts";

const maxEntries = 64;
const maxRetainedBytes = 4 * 1024 * 1024;

export type UserPromptHookEvidence = {
  readonly path: string | undefined;
  readonly turnId: string;
  readonly hasText: boolean;
  readonly pasteEnvelopeId?: string | undefined;
};

export type RecoveredUserPrompt = {
  readonly path: string;
  readonly turnId: string;
  readonly summary: UserPromptPresentation & {
    readonly kind: "user_message";
    readonly label: "user";
  };
};
type RecordEvidence = UserPromptRecord & {
  readonly kind: "record";
  readonly retainedSizeBytes: number;
};
type HookEvidence = { readonly kind: "hook"; readonly pasteEnvelopeId: string | undefined };
type PromptEvidence = { readonly path: string } & (RecordEvidence | HookEvidence);

export class ClaudeUserPrompts {
  private readonly entries = new Map<string, PromptEvidence>();
  private readonly shown = new Set<string>();
  private retainedBytes = 0;
  private readonly emit: (prompt: RecoveredUserPrompt) => void;

  constructor(emit: (prompt: RecoveredUserPrompt) => void) {
    this.emit = emit;
  }

  clearUnpaired(): void {
    this.entries.clear();
    this.retainedBytes = 0;
  }

  forget(path: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.path === path) this.remove(key);
    }
  }

  /** Returns whether a nonblank hook still needs user activity, even without a path. */
  observeHook(
    { path, turnId, hasText, pasteEnvelopeId }: UserPromptHookEvidence,
    canRecover: boolean,
  ): boolean {
    if (Buffer.byteLength(turnId) > maxIdentifierBytes) return hasText;
    if (this.shown.has(turnId)) return false;
    const identity = promptLocation(canRecover ? path : undefined, turnId);
    if (hasText) {
      this.rememberShown(turnId);
      this.remove(identity?.key);
      return true;
    }
    if (!identity) return false;
    const { key } = identity;
    const known = this.entries.get(key);
    if (known?.kind === "record") {
      this.publish(identity.path, turnId, key, known, pasteEnvelopeId);
    } else if (known === undefined)
      this.remember(key, { kind: "hook", path: identity.path, pasteEnvelopeId });
    return false;
  }

  /**
   * Resolve only the matching authenticated blank hook. The read gets the retained
   * entry by reference, so eviction ends its eligibility to retry.
   */
  recoverInitial(
    path: string,
    turnId: string,
    read: (pendingToken: object) => InitialUserPrompt | undefined,
  ): void {
    const identity = promptLocation(path, turnId);
    if (!identity || this.shown.has(turnId)) return;
    const pending = this.entries.get(identity.key);
    if (pending?.kind !== "hook") return;
    const prompt = read(pending);
    if (prompt?.turnId === turnId)
      this.publish(path, turnId, identity.key, prompt, pending.pasteEnvelopeId);
  }

  /** Publish an exact pending path/ID match or retain text for a hook that arrives later. */
  observeForwardRecord(path: string, turnId: string, item: unknown): void {
    if (
      !isRecord(item) ||
      item["type"] !== "user" ||
      item["promptId"] !== turnId ||
      this.shown.has(turnId)
    )
      return;
    const identity = promptLocation(path, turnId);
    if (!identity) return;
    const { key } = identity;
    const known = this.entries.get(key);
    if (known?.kind === "record") return;
    const prompt = userPromptRecord(item);
    if (prompt === undefined) return;
    if (known?.kind === "hook") {
      this.publish(path, turnId, key, prompt, known.pasteEnvelopeId);
      return;
    }
    this.remember(key, {
      kind: "record",
      path,
      ...prompt,
      retainedSizeBytes: Buffer.byteLength(prompt.text),
    });
  }

  private publish(
    path: string,
    turnId: string,
    key: string,
    prompt: UserPromptRecord,
    pasteEnvelopeId: string | undefined,
  ): void {
    this.rememberShown(turnId);
    this.remove(key);
    this.emit({
      path,
      turnId,
      summary: {
        kind: "user_message",
        label: "user",
        ...claudePromptPresentation(
          prompt.text,
          prompt.isSingleTextContent ? pasteEnvelopeId : undefined,
        ),
      },
    });
  }

  private rememberShown(turnId: string): void {
    this.shown.add(turnId);
    if (this.shown.size > maxEntries) this.shown.delete(this.shown.values().next().value!);
  }

  private remember(key: string, evidence: PromptEvidence): void {
    this.entries.set(key, evidence);
    if (evidence.kind === "record") this.retainedBytes += evidence.retainedSizeBytes;
    while (this.entries.size > maxEntries || this.retainedBytes > maxRetainedBytes) {
      this.remove(this.entries.keys().next().value);
    }
  }

  private remove(key: string | undefined): void {
    if (key === undefined) return;
    const evidence = this.entries.get(key);
    if (evidence?.kind === "record") this.retainedBytes -= evidence.retainedSizeBytes;
    this.entries.delete(key);
  }
}

function promptLocation(path: string | undefined, turnId: string) {
  return path !== undefined &&
    isAbsolute(path) &&
    Buffer.byteLength(path) <= maxPathBytes &&
    Buffer.byteLength(turnId) <= maxIdentifierBytes
    ? { path, key: JSON.stringify([path, turnId]) }
    : undefined;
}
