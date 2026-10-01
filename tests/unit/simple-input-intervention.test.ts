/** Raw edits revoke awaited ergonomic input without leaking picker errors (PRD §5.3, C-API-56). */
import { afterEach, expect, test, vi } from "vitest";
import { elwoodError } from "../../src/core/errors.ts";
import { submissionError } from "../../src/core/input/abort.ts";
import { AgentSessionBase } from "../../src/runtime/session/base.ts";
import { emptyComposer } from "../fixtures/owned-turn/composer.ts";
import { createFacadeFixture, nativeHooks, resetAdapters } from "../fixtures/owned-turn/session.ts";

afterEach(() => {
  vi.useRealTimers();
  resetAdapters();
});

for (const agent of ["claude", "codex"] as const) {
  for (const surface of ["send", "stream"] as const) {
    for (const phase of ["initial", "replay"] as const) {
      test.each([
        "keys",
        "terminal",
        "xterm",
      ] as const)(`C-API-56 ${agent} ${surface} ${phase} reports raw %s takeover of pending input consumption`, async (route) => {
        const { helper, cwd, facade } = createFacadeFixture(agent);
        const live = await facade.start();
        const pty = helper.ptys[0]!;
        let result: Promise<unknown> | undefined;
        try {
          await nativeHooks(agent, live, cwd, pty).ready();
          await expect.poll(() => live.status).toBe("ready");
          vi.useFakeTimers();
          let settled = false;
          const work =
            surface === "send"
              ? facade.send("owned prompt")
              : (async () => {
                  for await (const event of facade.stream("owned prompt")) void event;
                })();
          result = work
            .catch((error: unknown) => error)
            .finally(() => {
              settled = true;
            });
          await vi.advanceTimersByTimeAsync(200);
          expect(pty.writes).toEqual(["\u001b[200~owned prompt\u001b[201~", "\r"]);
          expect(settled).toBe(false); // Enter occurred; no fresh empty-input frame acknowledged it.
          if (phase === "replay") {
            if (!(live instanceof AgentSessionBase))
              throw new Error("Expected real adapter session");
            pty.emitData(emptyComposer(agent));
            await vi.advanceTimersByTimeAsync(1_000);
            live.submitEvidence("hook_turn_ended");
            await vi.advanceTimersByTimeAsync(2_160);
            expect(pty.writes).toEqual([
              "\u001b[200~owned prompt\u001b[201~",
              "\r",
              "\u001b[200~owned prompt\u001b[201~",
              "\r",
            ]);
            expect(settled).toBe(false); // Replay Enter still lacks fresh empty-input confirmation.
          }
          const rawDraft = "caller replacement with private details";
          if (route === "keys") await facade.sendKeys(rawDraft);
          else if (route === "terminal") await live.terminal.sendInput(Buffer.from(rawDraft));
          else live.terminal.xterm.input(rawDraft);
          const afterRaw = [...pty.writes];
          expect(afterRaw.at(-1)).toBe(rawDraft);
          await vi.advanceTimersByTimeAsync(4_000);
          expect(settled).toBe(true);
          expect(await result).toMatchObject({
            name: "ElwoodError",
            code: "wait_timeout",
            message: "Raw input replaced the staged turn input.",
            details: {},
          });
          expect(pty.writes).toEqual(afterRaw); // Neither cleanup nor recovery edits the raw draft.
        } finally {
          vi.useRealTimers();
          await facade.teardown();
          await result;
        }
      });
    }
  }
}

test("C-ERR-01 submission translation preserves unmarked errors, including picker-shaped errors", () => {
  for (const error of [
    elwoodError("model_automation_failed", "Raw input replaced the model picker operation."),
    elwoodError("wait_timeout", "Existing input failure"),
    new Error("Physical write failed"),
    "not an Error",
    undefined,
  ])
    expect(submissionError(error)).toBe(error);
});
