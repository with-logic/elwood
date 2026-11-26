/**
 * Messages queued during a running Claude turn (PRD §5.4, C-API-62). Claude fires a queued
 * message's `UserPromptSubmit` with the running turn's prompt ID. When an interrupt cancels that
 * screening, Claude fires it again under a new prompt ID as it runs the message as its own turn.
 * A queued message stays pending until that second hook claims it or the transcript shows its
 * delivery: a `remove` queue operation inside the turn, or a `queued` user record as a new turn,
 * which Claude writes only after the second hook.
 */
import { isRecord } from "../../core/predicates.ts";
import { maxPromptEntries, textDigest } from "./prompt-keys.ts";
import { userPromptRecord } from "./user-record.ts";

export class ClaudeQueuedPrompts {
  private readonly pending: string[] = [];

  queued(prompt: string): void {
    this.pending.push(textDigest(prompt));
    if (this.pending.length > maxPromptEntries) this.pending.shift();
  }

  observeRecord(item: unknown): void {
    if (!isRecord(item)) return;
    const delivered =
      item["type"] === "queue-operation"
        ? item["operation"] === "remove" && item["content"]
        : item["promptSource"] === "queued" && userPromptRecord(item)?.text;
    if (typeof delivered === "string") this.claim(delivered);
  }

  clear(): void {
    this.pending.length = 0;
  }

  /** Whether a message with this exact text is pending, which this claims. */
  claim(text: string): boolean {
    const index = this.pending.indexOf(textDigest(text));
    if (index >= 0) this.pending.splice(index, 1);
    return index >= 0;
  }
}
