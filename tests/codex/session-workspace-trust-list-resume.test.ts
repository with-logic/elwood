/** Verify workspace trust discovery on the resumed Codex startup path (C-ATTN-07). */
import { afterEach, assert, expect, test, vi } from "vitest";
import { resumeCodex } from "../../src/index.ts";
import { becomeReady, ptys, resetFakes } from "./helpers.ts";
import { clear, menu, setup } from "./workspace-trust-discovery-fixture.ts";

afterEach(resetFakes);

test("C-ATTN-07/C-ATTN-08 resumed sessions list and announce the verified startup trust prompt", async () => {
  const { cwd, session: original } = await setup();
  try {
    const resumeId = "codex-trust-resume";
    await becomeReady(original.elwoodSessionId, cwd, { session_id: resumeId });
    await original.stop();

    const resumed = await resumeCodex({ cwd, elwoodSessionId: original.elwoodSessionId });
    try {
      const pty = ptys[1];
      assert.isDefined(pty);
      expect(pty.options.args.join(" ")).toContain(`resume '${resumeId}'`);
      pty.emitData(clear + menu(cwd));
      await resumed.terminal.settled();
      const observed = vi.fn();
      resumed.on("dialog", observed);
      await expect
        .poll(() => observed.mock.calls)
        .toEqual([
          [
            {
              phase: "raised",
              request: expect.objectContaining({
                elwoodSessionId: original.elwoodSessionId,
                targetPath: cwd,
                targetScope: "folder",
              }),
            },
          ],
        ]);
      expect(await resumed.listDialogs()).toEqual([observed.mock.lastCall?.[0].request]);
      expect(pty.writes).toEqual([]);
    } finally {
      await resumed.teardown();
    }
  } finally {
    await original.teardown();
  }
});
