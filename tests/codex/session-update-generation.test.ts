/** A replaced version banner emits one generation signal (PRD §5.4/§5.5, C-CODEX-12). */
import { afterEach, expect, test, vi } from "vitest";
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test.each([
  false,
  true,
])("C-CODEX-12 changed banners signal once without claiming answered (throwing observer: %s)", async (throws) => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  const events: ElwoodActivityEvent[] = [];
  session.on("activity", (event) => {
    events.push(event);
    if (throws && event.promptGeneration !== undefined) throw new Error("observer failure");
  });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    vi.useFakeTimers();
    const paint = async (version: string) => {
      ptys[0]!.emitData(
        `\u001b[2J\u001b[HUpdate available! ${version}\r\n1. Update now\r\n2. Skip`,
      );
      await vi.advanceTimersByTimeAsync(50);
    };
    await paint("0.153.3 -> 0.153.4");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      events.filter((event) => event.kind === "attention" && event.label === "codex-update-prompt"),
    ).toHaveLength(1);
    await paint("0.153.3 -> 0.153.4\r\nUpdate available! 0.153.4 -> 0.154.0");
    await paint("0.153.3 -> 0.153.4\r\nUpdate available! 0.153.4 -> 0.154.0");
    expect(events.filter((event) => event.promptGeneration !== undefined)).toEqual([]);
    expect(ptys[0]!.writes).toHaveLength(20);
    await paint("0.153.4 -> 0.154.0");
    await paint("0.153.4 -> 0.154.0");
    const changed = events.filter((event) => event.promptGeneration !== undefined);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      kind: "attention",
      label: "codex-update-prompt",
      promptGeneration: 3,
    });
    expect(session.status).toBe("blocked");
    expect(events.filter((event) => event.kind === "startup_prompt")).toEqual([]);
    expect(ptys[0]!.writes.length).toBeGreaterThan(20);
  } finally {
    vi.useRealTimers();
    await session.stop();
  }
});
