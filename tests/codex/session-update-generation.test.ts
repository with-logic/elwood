/** Fresh update evidence emits one bounded generation signal (PRD §5.4/§5.5, C-CODEX-12). */
import { afterEach, expect, test, vi } from "vitest";
import {
  CodexUpdateAttentionGuard,
  codexUpdateAttentionGraceMs,
} from "../../src/cli/update-attention.ts";
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test.each([
  { name: "changed version", throws: false, sameVersion: false },
  { name: "throwing observer", throws: true, sameVersion: false },
  { name: "same version after ambiguity", throws: false, sameVersion: true },
])("C-CODEX-12 $name renews grace once without claiming answered", async ({
  throws,
  sameVersion,
}) => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  const events: ElwoodActivityEvent[] = [];
  const attentionAt: number[] = [];
  const blocked = vi.fn();
  const guard = new CodexUpdateAttentionGuard(session, { block: blocked });
  session.on("activity", (event) => {
    events.push(event);
    if (event.kind === "attention" && event.label === "codex-update-prompt") {
      attentionAt.push(Date.now());
      guard.attention(event.promptGeneration);
    }
    if (throws && event.promptGeneration !== undefined) throw new Error("observer failure");
  });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    vi.useFakeTimers();
    const paint = async (frame: string) => {
      ptys[0]!.emitData(`\u001b[2J\u001b[H${frame.replaceAll("\n", "\r\n")}`);
      await vi.advanceTimersByTimeAsync(50);
    };
    const choices = "1. Update now\n2. Skip";
    const banner = "Update available! 0.153.3 -> 0.153.4";
    const nextBanner = "Update available! 0.153.4 -> 0.154.0";
    const update = `${banner}\n${choices}`;
    await paint(update);
    await vi.advanceTimersByTimeAsync(5_000);
    const ambiguous = sameVersion
      ? `${update}\nConfirm archive removal?`
      : `${banner}\n${nextBanner}\n${choices}`;
    await paint(ambiguous);
    await paint(ambiguous);
    await paint(choices);
    if (sameVersion) {
      await paint(banner);
      await paint(`${banner}\n1. Update now`);
      await paint(choices);
    }
    expect(attentionAt).toHaveLength(1);
    expect(events.filter((event) => event.promptGeneration !== undefined)).toEqual([]);
    expect(ptys[0]!.writes).toHaveLength(20);
    const fresh = `${sameVersion ? banner : nextBanner}\n${choices}`;
    await paint(fresh);
    await paint(fresh);
    const changed = events.filter((event) => event.promptGeneration !== undefined);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ kind: "attention", label: "codex-update-prompt" });
    expect(changed[0]?.promptGeneration).toBeGreaterThan(1);
    expect(session.status).toBe("blocked");
    expect(events.filter((event) => event.kind === "startup_prompt")).toEqual([]);
    expect(ptys[0]!.writes.length).toBeGreaterThan(20);
    await vi.advanceTimersByTimeAsync(
      attentionAt[0]! + codexUpdateAttentionGraceMs - Date.now() + 1,
    );
    expect(blocked).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(attentionAt[1]! + codexUpdateAttentionGraceMs - Date.now());
    expect(blocked).toHaveBeenCalledExactlyOnceWith("codex-update-prompt");
  } finally {
    guard.dispose();
    vi.useRealTimers();
    await session.stop();
  }
});
