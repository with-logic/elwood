/** Match blank authenticated Claude hooks to committed user records (PRD §5.4). */
import { isAbsolute } from "node:path";
import { isRecord } from "../../core/predicates.ts";
import { maxIdentifierBytes, maxPathBytes } from "./turn-identity.ts";
import { userPromptText } from "./user-record.ts";

const maxEntries = 64;
const maxRetainedBytes = 4 * 1024 * 1024;

export type RecoveredUserPrompt = {
  readonly path: string;
  readonly turnId: string;
  readonly item: unknown;
  readonly summary: {
    readonly kind: "user_message";
    readonly label: "user";
    readonly text: string;
  };
};
type RecordEvidence = {
  readonly kind: "record";
  readonly bytes: Buffer;
};
type PromptEvidence = RecordEvidence | { readonly kind: "hook" };

export class ClaudeUserPrompts {
  private readonly entries = new Map<string, PromptEvidence>();
  private readonly shown = new Set<string>();
  private retainedBytes = 0;
  private readonly emit: (prompt: RecoveredUserPrompt) => void;

  constructor(emit: (prompt: RecoveredUserPrompt) => void) {
    this.emit = emit;
  }

  clear(): void {
    this.entries.clear();
    this.shown.clear();
    this.retainedBytes = 0;
  }

  /** Returns whether a nonblank hook still needs user activity, even without a path. */
  observeHook(path: string | undefined, turnId: string, hasText: boolean): boolean {
    if (Buffer.byteLength(turnId) > maxIdentifierBytes) return hasText;
    if (this.shown.has(turnId)) return false;
    const key = promptKey(path, turnId);
    if (hasText) {
      this.rememberShown(turnId);
      this.remove(key);
      return true;
    }
    if (key === undefined) return false;
    const known = this.entries.get(key);
    if (known?.kind === "record") {
      // This buffer is an owned copy of the exact JSONL line checked at insertion.
      const item: unknown = JSON.parse(known.bytes.toString("utf8"));
      const text = matchingPromptText(item, turnId);
      if (text !== undefined) {
        this.publish(path!, turnId, key, item, text);
        return false;
      }
      this.remove(key);
    }
    if (known?.kind !== "hook") this.remember(key, { kind: "hook" });
    return false;
  }

  committed(path: string, turnId: string, item: unknown, line: string): void {
    if (this.shown.has(turnId)) return;
    const key = promptKey(path, turnId);
    if (key === undefined) return;
    const known = this.entries.get(key);
    if (known?.kind === "record") return;
    const text = matchingPromptText(item, turnId);
    if (text === undefined) return;
    if (known?.kind === "hook") {
      this.publish(path, turnId, key, item, text);
      return;
    }
    const bytes = Buffer.byteLength(line);
    if (bytes <= maxRetainedBytes) this.remember(key, { kind: "record", bytes: Buffer.from(line) });
  }

  private publish(path: string, turnId: string, key: string, item: unknown, text: string): void {
    this.rememberShown(turnId);
    this.remove(key);
    this.emit({
      path,
      turnId,
      item,
      summary: { kind: "user_message", label: "user", text },
    });
  }

  private rememberShown(turnId: string): void {
    this.shown.add(turnId);
    if (this.shown.size > maxEntries) this.shown.delete(this.shown.values().next().value!);
  }

  private remember(key: string, evidence: PromptEvidence): void {
    this.entries.set(key, evidence);
    if (evidence.kind === "record") this.retainedBytes += evidence.bytes.length;
    while (this.entries.size > maxEntries || this.retainedBytes > maxRetainedBytes) {
      this.remove(this.entries.keys().next().value);
    }
  }

  private remove(key: string | undefined): void {
    if (key === undefined) return;
    const evidence = this.entries.get(key);
    if (evidence?.kind === "record") this.retainedBytes -= evidence.bytes.length;
    this.entries.delete(key);
  }
}

function matchingPromptText(item: unknown, turnId: string): string | undefined {
  return isRecord(item) && item["promptId"] === turnId ? userPromptText(item) : undefined;
}

function promptKey(path: string | undefined, turnId: string): string | undefined {
  return path !== undefined &&
    isAbsolute(path) &&
    Buffer.byteLength(path) <= maxPathBytes &&
    Buffer.byteLength(turnId) <= maxIdentifierBytes
    ? JSON.stringify([path, turnId])
    : undefined;
}
