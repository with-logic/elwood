/** Update choices must belong to one native numbered block (PRD §5.5, C-CODEX-12). */
import { afterEach, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { safeUpdateOption } from "../../src/codex/update/selection.ts";
import { codexOptionStillSafe } from "../../src/codex/update-prompt.ts";

const banner = "Update available! 0.153.3 -> 0.153.4";
const first = `${banner}\n1. Update now\n2. Skip`;
afterEach(() => vi.useRealTimers());

test.each([
  `${first}\n1. Delete archive\n2. Keep archive`,
  `${first}\n1. Update now\n2. Skip`,
  `${first}\n1. Skip`,
  `${first}\n3. Delete archive`,
  `${banner}\n1. Up\n2. Skip`,
  `2.\n${first}`,
  `› 2.\n${first}`,
  ...["1.Update now", "2.Skip", "›1.Update now", ">2.Skip"].map(
    (row) => `${row}\n${banner}\n2.Skip`,
  ),
])("C-CODEX-12 ambiguous numbered rows never receive an update retry: %s", async (replacement) => {
  vi.useFakeTimers();
  let frame = first;
  const writes: string[] = [];
  const responder = new CodexStartupPromptResponder();
  const initial = responder.handle(
    frame,
    (key) => void writes.push(key),
    () => frame,
  );
  frame = replacement;
  await vi.runAllTimersAsync();
  await expect(initial.outcomes[0]?.settled).resolves.toBe("cancelled");
  expect(writes).toEqual(["2"]);
  expect(safeUpdateOption(frame)).toBeUndefined();
  expect(codexOptionStillSafe(frame, "2")).toBe(false);
  responder.dispose();
});
