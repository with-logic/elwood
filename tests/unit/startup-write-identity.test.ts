/**
 * Exhaustion case for #42: an attempt captures the identity of the choice it decided on,
 * and the settled frame must still BE that choice, so the guard closes the class rather
 * than three named instances (PRD §5.4, C-CODEX-12).
 *
 * Verifying this: the fail-before baseline is `origin/main` (or the last merged commit),
 * NEVER `HEAD` — once the branch carries an earlier round's fix, reverting only the call
 * sites leaves that protection in place and this passes for the wrong reason.
 */
import { expect, test } from "vitest";
import {
  codexUpdateChoiceIdentity,
  settledFrameKeepsChoice,
} from "../../src/codex/update/identity.ts";
import {
  codexUpdatePromptVisible,
  guardedCodexAutomationWrite,
  writeCodexUpdateSkip,
} from "../../src/codex/update/index.ts";
import { numberedOptions } from "../../src/core/terminal-options.ts";

test("C-CODEX-12 only the dialog the attempt captured can take its key", async () => {
  const updateScreen = "Update available! 0.148.0 -> 0.149.1\n\u203a 1. Update now\n  2. Skip";
  const settleInto = async (replacement: string): Promise<number> => {
    const writes: string[] = [];
    let frame = updateScreen;
    const guarded = guardedCodexAutomationWrite(
      {
        sendInput: () => undefined,
        settled: () =>
          new Promise<void>((resolve) => {
            queueMicrotask(() => {
              frame = replacement;
              resolve();
            });
          }),
        renderFailed: false,
      },
      (input: string) => void writes.push(input),
      () => frame,
    );
    await writeCodexUpdateSkip("2", guarded, () => frame, codexUpdatePromptVisible);
    return writes.length;
  };
  // A LATER appearance of the same screen: different version pair, same option text.
  expect(
    await settleInto("Update available! 0.150.0 -> 0.151.0\n\u203a 1. Update now\n  2. Skip"),
  ).toBe(0);
  // Renumbered: "2" now names a destructive choice.
  expect(
    await settleInto(
      "Update available! 0.149.0 -> 0.150.0\n\u203a 1. Update now\n  2. Reset settings\n  3. Skip",
    ),
  ).toBe(0);
  // An unrelated human decision that merely offers a "Skip" option.
  expect(
    await settleInto("Delete this project's saved settings?\n  1. Yes, delete\n  2. Skip"),
  ).toBe(0);
  // The captured option number is simply gone from the settled frame.
  expect(await settleInto("Update available! 0.148.0 -> 0.149.1\n\u203a 1. Update now")).toBe(0);
  // The dialog the attempt actually captured still receives its key.
  expect(await settleInto(updateScreen)).toBeGreaterThan(0);
});

test("C-CODEX-12 the identity closure is what gates the settled frame", async () => {
  const updateScreen = "Update available! 0.148.0 -> 0.149.1\n\u203a 1. Update now\n  2. Skip";
  // Drive the barrier directly with the same per-write shape `writeCodexUpdateSkip`
  // builds, so each branch of the identity closure is exercised on its own terms.
  const writes: string[] = [];
  const guarded = guardedCodexAutomationWrite(
    { sendInput: () => undefined, settled: () => Promise.resolve(), renderFailed: false },
    (input: string) => void writes.push(input),
    () => updateScreen,
  );
  // Disowned by the attempt's predicate: withheld even though the frame is unchanged.
  expect(await guarded("2", () => false)).toBe("withheld");
  // Owned: the key stands.
  expect(await guarded("2", () => true)).toBe("written");
  // No per-write predicate at all: the option check alone applies.
  expect(await guarded("2")).toBe("written");
  expect(writes).toEqual(["2", "2"]);
});

test("C-CODEX-12 every way a settled frame can stop being the captured choice", () => {
  const captured = "Update available! 0.148.0 -> 0.149.1\n\u203a 1. Update now\n  2. Skip";
  const option = numberedOptions(captured).find((candidate) => candidate.number === "2")!;
  const identity = codexUpdateChoiceIdentity(captured, option);
  const keeps = (frame: string, stillUpdate = codexUpdatePromptVisible) =>
    settledFrameKeepsChoice(frame, identity, "2", stillUpdate);
  // The same dialog: the key stands.
  expect(keeps(captured)).toBe(true);
  // The attempt's own generation predicate disowns the frame.
  expect(keeps(captured, () => false)).toBe(false);
  // The captured option number is no longer present at all.
  expect(keeps("Update available! 0.148.0 -> 0.149.1\n\u203a 1. Update now")).toBe(false);
  // The number is present but now names something else (renumbered dialog).
  expect(
    keeps(
      "Update available! 0.149.0 -> 0.150.0\n\u203a 1. Update now\n  2. Reset settings\n  3. Skip",
    ),
  ).toBe(false);
  // A later appearance: same option text, different version pair.
  expect(keeps("Update available! 0.150.0 -> 0.151.0\n\u203a 1. Update now\n  2. Skip")).toBe(
    false,
  );
});
