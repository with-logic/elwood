/** Handle optional Claude snapshot failures during rendering and responder updates (C-ATTN-08). */
import { realpathSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { type ElwoodDialogEvent, type ElwoodWarningEvent, startClaude } from "../../src/index.ts";
import { settledNativeSnapshot } from "../../src/terminal/cursor.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { trustFrame } from "./workspace-trust-discovery-fixture.ts";

vi.mock("../../src/terminal/cursor.ts", { spy: true });
afterEach(() => {
  vi.mocked(settledNativeSnapshot).mockReset();
  resetFakes();
});

test.each([
  false,
  true,
])("C-ATTN-08 failed Claude reconciliation retires only an announced dialog (%s)", async (announced) => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd });
  const events = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  const warnings = vi.fn<(warning: ElwoodWarningEvent) => void>();
  session.on("warning", warnings);
  if (announced) session.on("dialog", events);
  const render = async () => {
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
  };
  try {
    await render();
    if (announced) await expect.poll(() => events.mock.calls.length).toBe(1);
    const snapshot = vi.mocked(settledNativeSnapshot).mockImplementationOnce(() => {
      throw new Error("Optional snapshot failed");
    });
    const callsBefore = snapshot.mock.calls.length;
    await render();
    expect(snapshot.mock.calls.length).toBeGreaterThan(callsBefore);
    if (announced) {
      const request = events.mock.calls[0]?.[0].request;
      expect(events.mock.calls).toEqual([
        [{ phase: "raised", request }],
        [{ phase: "closed", reason: "unavailable", request }],
      ]);
      expect(await session.listDialogs()).toEqual([]);
    } else {
      expect(await session.listDialogs()).toHaveLength(1);
    }
    expect(warnings).not.toHaveBeenCalled();
    expect(session.status).toBe("blocked");
    expect(ptys[0]!.writes).toEqual([]);
  } finally {
    await session.teardown();
  }
});
