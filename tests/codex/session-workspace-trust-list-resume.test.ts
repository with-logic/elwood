/** Verify workspace trust discovery on the resumed Codex startup path (C-ATTN-07). */
import { afterEach, assert, expect, test, vi } from "vitest";
import { resumeCodex } from "../../src/index.ts";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { becomeReady, ptys, resetFakes } from "./helpers.ts";
import { clear, menu, setup } from "./workspace-trust-discovery-fixture.ts";

afterEach(resetFakes);

test("C-ATTN-07/C-ATTN-08 resumed sessions list, announce, and answer the verified startup trust prompt", async () => {
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
      const [request] = await resumed.listDialogs();
      assert.isDefined(request);
      const readyInput = Promise.withResolvers<void>();
      resumed.on("status", ({ status }) => {
        if (status === "ready")
          void resumed.sendKeys("draft").then(readyInput.resolve, readyInput.reject);
      });
      const answer = resumed.answerDialog(request.id, request.choices[0]!.id);
      await expect.poll(() => pty.writes).toEqual(["\r"]);
      pty.emitData(clear + codexTty(codexComposer));
      await expect(answer).resolves.toBeUndefined();
      await readyInput.promise;
      expect(pty.writes).toEqual(["\r", "draft"]);
    } finally {
      await resumed.teardown();
    }
  } finally {
    await original.teardown();
  }
});

test("C-TRUST-01 caller input on a resumed workspace prelude prevents automatic confirmation", async () => {
  const { cwd, session: original } = await setup();
  try {
    const resumeId = "codex-trust-resume-prelude";
    await becomeReady(original.elwoodSessionId, cwd, { session_id: resumeId });
    await original.stop();

    const resumed = await resumeCodex({
      cwd,
      autotrust: true,
      elwoodSessionId: original.elwoodSessionId,
    });
    try {
      const pty = ptys[1];
      assert.isDefined(pty);
      expect(pty.options.args.join(" ")).toContain(`resume '${resumeId}'`);
      const observed = vi.fn();
      resumed.on("dialog", observed);
      const full = menu(cwd);
      pty.emitData(clear + full.split("  Trust this folder?")[0]!);
      await resumed.terminal.settled();
      await resumed.sendKeys("x");
      pty.emitData(clear + full);
      await resumed.terminal.settled();

      expect(pty.writes).toEqual(["x"]);
      await expect
        .poll(() => observed.mock.calls)
        .toMatchObject([[{ phase: "raised", request: { targetPath: cwd } }]]);
    } finally {
      await resumed.teardown();
    }
  } finally {
    await original.teardown();
  }
});
