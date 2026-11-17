/** Public Claude interrupts retry a swallowed Escape (PRD §5.3, C-API-38). */
import { afterEach, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test("C-API-38 concurrent Claude interrupts share one delayed Escape retry", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd });
  await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "InstructionsLoaded",
    session_id: "claude-1",
    cwd,
    file_path: "/tmp/CLAUDE.md",
    memory_type: "Project",
    load_reason: "session_start",
  });
  await session.sendMessage("write a long essay");
  vi.useFakeTimers();
  const first = session.interrupt();
  const second = session.interrupt();
  await vi.advanceTimersByTimeAsync(249);
  expect(ptys[0]!.writes.filter((input) => input === "\u001b")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(ptys[0]!.writes.filter((input) => input === "\u001b")).toHaveLength(2);
  await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "Stop",
    session_id: "claude-1",
    cwd,
    stop_hook_active: false,
  });
  await Promise.all([first, second]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(ptys[0]!.writes.filter((input) => input === "\u001b")).toHaveLength(2);
  expect(session.status).toBe("ready");
});
