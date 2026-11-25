/** Check the existing C-ATTN-08 close reason when automation takes over a settled replacement. */
import { afterEach, assert, expect, test, vi } from "vitest";
import { gateBudgetMs } from "../../src/core/trust/deadline.ts";
import type { ElwoodDialogEvent } from "../../src/index.ts";
import { resetFakes } from "./helpers.ts";
import { clear, menu, setup } from "./workspace-trust-discovery-fixture.ts";

const renderMarginMs = 50;

afterEach(resetFakes);

test("C-ATTN-08 supported settled replacement closes as replaced while automation owns it", async () => {
  const { session, cwd, pty } = await setup({ autotrust: true });
  const events = vi.fn<(event: ElwoodDialogEvent) => void>();
  session.on("dialog", events);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  try {
    const original = menu(cwd);
    pty.emitData(`\x1b[?2026h${clear}${original}`);
    // Keep synchronization open so the gate can expire without an automatic write.
    await vi.advanceTimersByTimeAsync(gateBudgetMs + renderMarginMs);
    expect(session.status).toBe("blocked");
    expect(pty.writes).toEqual([]);
    pty.emitData("\x1b[?2026l");
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(events).toHaveBeenCalledTimes(1));
    const [request] = await session.listDialogs();
    assert.isDefined(request);
    expect(events.mock.calls).toEqual([[{ phase: "raised", request } satisfies ElwoodDialogEvent]]);

    const partial = original.slice(0, original.indexOf("› 1."));
    pty.emitData(`\x1b[?2026h${clear}${partial}`);
    await vi.advanceTimersByTimeAsync(50);
    expect(events).toHaveBeenCalledTimes(1);
    pty.emitData(`${clear}${menu(cwd, "folder-access-no-hook-bypass")}\x1b[?2026l`);
    await vi.waitFor(() => expect(events).toHaveBeenCalledTimes(2));

    expect(pty.writes).toEqual(["1\r"]);
    expect(await session.listDialogs()).toEqual([]);
    expect(events.mock.calls[1]).toEqual([
      { phase: "closed", request, reason: "replaced" } satisfies ElwoodDialogEvent,
    ]);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
