/**
 * Match blank authenticated Claude hooks to committed user records. Show each nonblank hook unless
 * transcript recovery already showed its prompt, or it screens a still-queued message again
 * (PRD §5.4, C-API-62, C-API-63). Track queued messages for the `Stop` hold (§6.5, C-HOOK-24).
 */
import { isRecord } from "../../core/predicates.ts";
import { claudePromptPresentation } from "../pasted-content.ts";
import type { InitialUserPrompt } from "./initial-prompt.ts";
import {
  addBounded,
  maxPromptEntries,
  promptLocation,
  textDigest,
  turnDigestKey,
} from "./prompt-keys.ts";
import { ClaudeQueuedPrompts, type QueuedPromptsAccess } from "./queued-prompts.ts";
import { maxIdentifierBytes } from "./turn-identity.ts";
import type {
  PromptEvidence,
  RecoveredUserPrompt,
  UserPromptHookEvidence,
} from "./user-prompt-types.ts";
import { type UserPromptRecord, userPromptRecord } from "./user-record.ts";

const maxRetainedBytes = 4 * 1024 * 1024;

export class ClaudeUserPrompts {
  private readonly entries = new Map<string, PromptEvidence>();
  // A shown prompt ID is not a shown submission: Claude fires the hook for a message queued
  // during a running turn with that turn's ID. A nonblank hook is suppressed only when transcript
  // recovery already showed that ID with the same text, or when it screens a still-queued message
  // again under a new ID. Blank hooks carry no text to tell submissions apart, so transcript
  // recovery still needs an unshown ID.
  private readonly shownTurnIds = new Set<string>();
  private readonly recoveredTextKeys = new Set<string>();
  private readonly queued = new ClaudeQueuedPrompts();
  private retainedBytes = 0;
  private readonly emit: (prompt: RecoveredUserPrompt) => void;

  constructor(emit: (prompt: RecoveredUserPrompt) => void) {
    this.emit = emit;
  }

  /** Without transcript evidence a queued message cannot be seen delivered, so none stays pending. */
  clearUnpaired(): void {
    this.entries.clear();
    this.queued.clear();
    this.retainedBytes = 0;
  }

  forgetQueued(): void {
    this.queued.clear();
  }
  get queuedPrompts(): QueuedPromptsAccess {
    return this.queued;
  }

  forget(path: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.path === path) this.remove(key);
    }
  }

  /** Returns whether a nonblank hook still needs user activity, even without a path. */
  observeHook(evidence: UserPromptHookEvidence, canRecover: boolean): boolean {
    const { path, turnId, pasteEnvelopeId } = evidence;
    if (Buffer.byteLength(turnId) > maxIdentifierBytes) return evidence.hasText;
    const identity = promptLocation(canRecover ? path : undefined, turnId);
    if (evidence.hasText) return this.showsTextHook(turnId, evidence.prompt, identity);
    if (this.shownTurnIds.has(turnId) || !identity) return false;
    const { key } = identity;
    const known = this.entries.get(key);
    if (known?.kind === "record") {
      this.publish(identity.path, turnId, key, known, pasteEnvelopeId);
    } else if (known === undefined)
      this.remember(key, { kind: "hook", path: identity.path, pasteEnvelopeId });
    return false;
  }

  private showsTextHook(
    turnId: string,
    prompt: string,
    identity: ReturnType<typeof promptLocation>,
  ) {
    let digest: string | undefined;
    const promptDigest = () => (digest ??= textDigest(prompt));
    const recovered = this.recoveredTextKeys;
    const hidden = recovered.size > 0 && recovered.has(turnDigestKey(turnId, promptDigest()));
    const textlessPending = identity && this.entries.get(identity.key)?.kind === "hook";
    // Only transcript correlation can show a queued message delivered, so only it tracks one. A
    // reused ID is a message queued during that running turn, even a hidden repeat of a recovered
    // prompt. Under a new ID, an interrupt made Claude screen a still-queued message again.
    const queues = identity && (textlessPending || this.shownTurnIds.has(turnId));
    if (queues) this.queued.queued(promptDigest(), !hidden);
    if (hidden) return false;
    if (!queues && identity && !this.queued.isEmpty && this.queued.claim(promptDigest())) {
      addBounded(this.shownTurnIds, turnId);
      return false;
    }
    // A textless submission under this ID still waits for its record; queued input keeps it.
    if (textlessPending) return true;
    addBounded(this.shownTurnIds, turnId);
    this.remove(identity?.key);
    return true;
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
    if (!identity || this.shownTurnIds.has(turnId)) return;
    const pending = this.entries.get(identity.key);
    if (pending?.kind !== "hook") return;
    const prompt = read(pending);
    if (prompt?.turnId === turnId)
      this.publish(path, turnId, identity.key, prompt, pending.pasteEnvelopeId);
  }

  /** Publish an exact pending path/ID match or retain text for a hook that arrives later. */
  observeForwardRecord(
    path: string,
    turnId: string | undefined,
    item: unknown,
    liveMainConversation: boolean,
  ): void {
    this.queued.observeRecord(item, liveMainConversation);
    if (
      turnId === undefined ||
      !isRecord(item) ||
      item["type"] !== "user" ||
      item["promptId"] !== turnId ||
      this.shownTurnIds.has(turnId)
    )
      return;
    // Its messages were shown at their own hooks; messages queued during it reuse its ID (C-HOOK-24).
    if (item["promptSource"] === "queued") return void addBounded(this.shownTurnIds, turnId);
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
    addBounded(this.shownTurnIds, turnId);
    addBounded(this.recoveredTextKeys, turnDigestKey(turnId, textDigest(prompt.text)));
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

  private remember(key: string, evidence: PromptEvidence): void {
    this.entries.set(key, evidence);
    if (evidence.kind === "record") this.retainedBytes += evidence.retainedSizeBytes;
    while (this.entries.size > maxPromptEntries || this.retainedBytes > maxRetainedBytes) {
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
