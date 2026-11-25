/** Keep structured answers within manual workspace trust policy (C-ATTN-07). */
import { realpathSync } from "node:fs";
import { afterEach, assert, expect, test, vi } from "vitest";
import { startCodex } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { clear, menu } from "./workspace-trust-discovery-fixture.ts";

afterEach(resetFakes);

test("C-ATTN-07 an expired automatic prompt remains discoverable without structured answer authority", async () => {
  installFakes();
  const cwd = realpathSync.native(tempDir());
  const session = await startCodex({ cwd, autotrust: true });
  const pty = ptys[0]!;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  try {
    pty.emitData(`\x1b[?2026h${clear}${menu(cwd)}`);
    await vi.advanceTimersByTimeAsync(5_050);
    pty.emitData("\x1b[?2026l");
    await vi.advanceTimersByTimeAsync(50);
    const [request] = await session.listDialogs();
    assert.isDefined(request);
    await expect(session.answerDialog(request.id, request.choices[0]!.id)).rejects.toMatchObject({
      code: "dialog_not_found",
    });
    expect(pty.writes).toEqual([]);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
