/**
 * Real Claude 2.1.310 folder-trust frames driven by a model of that dialog's input
 * behavior, read from the 2.1.310 binary: options wrap, the dialog remounts with its
 * focus back on "No, exit" once its input guard settles (150 ms after mount), and a
 * stalled event loop runs that overdue timer before queued input. A cursor answer must
 * land on the affirmative however its keys and that reset interleave (PRD §5.4,
 * C-CLAUDE-10, C-TRUST-01).
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeTrustClearance } from "../../src/claude/screen-table.ts";
import { TrustPromptResponder } from "../../src/core/trust/responder.ts";
import { claudeComposer } from "../fixtures/trust-composer.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/claude-2.1.310/${name}`, import.meta.url), "utf8");
/** Rendered with the cursor on index 0 ("No, exit", the default) or 1 ("Yes, ..."). */
const frames = [fixture("folder-trust-no.txt"), fixture("folder-trust-yes.txt")] as const;
const settleMs = 150; // The binary's input-guard window before the remount.
/** The chunk's keys in order: three-byte CSI cursor keys and single bytes. */
const keysOf = (chunk: string): string[] =>
  chunk.match(new RegExp(`${String.fromCharCode(27)}\\[[ABH]|\r`, "g")) ?? [];

class ClaudeTrustDialog {
  focus = 0;
  outcome: "pending" | "trusted" | "exited" = "pending";
  private stalledUntil = 0;
  private readonly queue: string[] = [];
  private readonly stalls: readonly (readonly [number, number])[];
  private readonly chunkGapMs: number;

  /** `stalls` are [fromMs, untilMs] spans in which the CLI's event loop runs nothing. */
  constructor(stalls: readonly (readonly [number, number])[], chunkGapMs: number) {
    this.stalls = stalls;
    this.chunkGapMs = chunkGapMs;
    // Created before any input timer, so at a stall's end the overdue settle runs first.
    const stall = stalls.find(([from, until]) => settleMs >= from && settleMs < until);
    setTimeout(() => {
      this.focus = 0;
    }, stall?.[1] ?? settleMs);
  }

  get frame(): string {
    return this.outcome === "trusted" ? claudeComposer : frames[this.focus === 1 ? 1 : 0];
  }

  write(chunk: string): void {
    this.queue.push(chunk);
    const now = Date.now();
    const stall = this.stalls.find(([from, until]) => now >= from && now < until);
    if (stall === undefined && this.queue.length === 1) this.drain();
    else if (stall !== undefined && stall[1] > this.stalledUntil) {
      this.stalledUntil = stall[1];
      setTimeout(() => this.drain(), stall[1] - now);
    }
  }

  /** One chunk per loop turn; each chunk's keys run synchronously, as in the CLI. */
  private drain(): void {
    const chunk = this.queue.shift();
    if (chunk === undefined || this.outcome !== "pending") return;
    for (const key of keysOf(chunk)) {
      if (key === "\r") this.outcome = this.focus === 1 ? "trusted" : "exited";
      else if (key === "\u001b[H") this.focus = 0;
      else this.focus = 1 - this.focus; // Up/Down on two rows wrap
      if (this.outcome !== "pending") return;
    }
    if (this.queue.length > 0) setTimeout(() => this.drain(), this.chunkGapMs);
  }
}

async function answer(dialog: ClaudeTrustDialog) {
  const writes: string[] = [];
  const responder = new TrustPromptResponder("claude", claudeTrustClearance, true);
  const result = responder.handle(
    dialog.frame,
    (input) => {
      writes.push(input);
      dialog.write(input);
    },
    () => dialog.frame,
  );
  if (result?.kind !== "attempted") throw new Error("expected an attempted trust answer");
  await vi.advanceTimersByTimeAsync(6_000);
  const settled = await result.settled;
  responder.dispose();
  return { settled, writes };
}

beforeEach(() => vi.useFakeTimers({ now: 0 }));
afterEach(() => vi.useRealTimers());

test("C-CLAUDE-10 the captured 2.1.310 frames render the dialog's own cursor rows", () => {
  expect(frames[0]).toContain(" ❯ No, exit\n   Yes, I trust this folder");
  expect(frames[1]).toContain("   No, exit\n ❯ Yes, I trust this folder");
});

test("C-TRUST-01 an Enter queued behind 2.1.310's settle remount still trusts the folder", async () => {
  // Observed 2026-10-25: the first key lands at once, then the loop stalls; the settle
  // timer (due at 150 ms) runs before the queued confirmation is read.
  const dialog = new ClaudeTrustDialog([[10, 200]], 10);
  const { settled, writes } = await answer(dialog);
  expect(dialog.outcome).toBe("trusted");
  expect(settled).toBe("answered");
  expect(writes).toEqual(["\u001b[H\u001b[B", "\u001b[H\u001b[B\r"]);
});

test("C-TRUST-01 a retried selection that lands late cannot wrap the cursor onto No, exit", async () => {
  // Observed 2026-10-25: a stalled first key is retried after 250 ms; both then land,
  // one loop turn apart, after the attempt has already seen the first one's repaint.
  const dialog = new ClaudeTrustDialog([[0, 300]], 30);
  const { settled, writes } = await answer(dialog);
  expect(dialog.outcome).toBe("trusted");
  expect(settled).toBe("answered");
  expect(writes.every((input) => input.startsWith("\u001b[H"))).toBe(true);
  expect(writes.filter((input) => input.includes("\r"))).toEqual(["\u001b[H\u001b[B\r"]);
});
