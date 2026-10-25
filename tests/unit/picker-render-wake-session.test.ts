/**
 * A real session wires its terminal's completed renders into picker waits, so a model
 * operation reads the picker on the render that paints it rather than at the next 100 ms
 * poll (PRD §5.3, C-API-23).
 */
import { afterEach, expect, test, vi } from "vitest";
import * as codex from "../codex/helpers.ts";
import { codexPickerViewport } from "../helpers/model-dialog-viewports.ts";
import { composerFrame, withComposerSession } from "./codex-composer/session-fixture.ts";

afterEach(() => codex.resetFakes());

/** Advances fake time in small steps until `done`, so no later poll is skipped over. */
async function advanceUntil(done: () => boolean): Promise<void> {
  for (let step = 0; step < 100 && !done(); step++) await vi.advanceTimersByTimeAsync(5);
}

test("C-API-23 a session's picker wait reads the opening picker on its render", async () => {
  await withComposerSession({ fakeTimers: true }, async ({ session, pty, emit, settle }) => {
    emit(composerFrame(""));
    await settle(1);
    const listing = session.listModels({ timeoutMs: 5_000 }).then(
      (models) => models.map((model) => model.id),
      (error: unknown) => error,
    );
    await advanceUntil(() => pty.writes.includes("/model"));
    emit(composerFrame("", "/model"), "/model");
    await settle(1);
    await advanceUntil(() => pty.writes.includes("\r"));
    // The open wait has just read a frame without the picker and polls again in 100 ms.
    await vi.advanceTimersByTimeAsync(10);
    emit(codexPickerViewport);
    await settle(1);
    await vi.advanceTimersByTimeAsync(5);
    // Read on its render: the Escape that ends the listing is already written.
    expect(pty.writes).toContain("\u001b");
    emit(composerFrame(""));
    await settle(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await listing).toContain("gpt-6-astra");
  });
});
