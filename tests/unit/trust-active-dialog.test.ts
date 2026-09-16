/** Active trust-dialog isolation and live-write validation (PRD §5.4, C-TRUST-01). */
import { expect, test } from "vitest";
import { TrustPromptResponder, trustPromptVisible } from "../../src/core/trust/responder.ts";

const permission =
  "Bash command\n  echo test\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel";
const trust = "Do you trust this folder?\n1. Yes\n2. No\nEnter to confirm";

test.each([
  `● The README says: Do you trust this folder?\n\n${permission}`,
  `Do you trust this folder?\n\n${permission}`,
  `${trust}\n\n${permission}`,
  `${trust}\n\n❯ Explain this dialog`,
  `${trust}\n\nNew permission dialog\n❯ Yes\n  No`,
  "Do you trust this folder?\n● A quoted prompt\n1. Yes\n2. No",
])("C-TRUST-01 never borrows a header or options from earlier viewport content: %s", (frame) => {
  const writes: string[] = [];
  expect(
    new TrustPromptResponder("claude", true).handle(frame, (key) => {
      writes.push(key);
    }),
  ).toBeUndefined();
  expect(trustPromptVisible(frame, "claude")).toBe(false);
  expect(writes).toEqual([]);
});

test.each([
  "\n\n",
  "\n───\n",
])("C-TRUST-01 selects the bottom-most trust dialog and its own option (%s)", async (separator) => {
  const frame = `Unrelated prompt\n1. Yes${separator}Load this skill?\n1. No\n2. Yes, load this skill`;
  const writes: string[] = [];
  const result = new TrustPromptResponder("claude", true).handle(frame, (key) => {
    writes.push(key);
  });
  expect(result).toMatchObject({
    kind: "answered",
    automation: { prompt: "skill_trust", input: "2" },
  });
  if (result?.kind !== "answered") throw new Error("expected answer");
  await result.settled;
  expect(writes).toEqual(["2\r"]);
});

test("C-TRUST-01 revalidates a numbered dialog before writing and leaves it retryable", async () => {
  const writes: string[] = [];
  const responder = new TrustPromptResponder("claude", true);
  const result = responder.handle(
    trust,
    (key) => {
      writes.push(key);
    },
    () => `${trust}\n${permission}`,
  );
  if (result?.kind !== "answered") throw new Error("expected attempted answer");
  await expect(result.settled).rejects.toThrow("disappeared before confirmation");
  expect(writes).toEqual([]);
  const retry = responder.handle(
    trust,
    (key) => {
      writes.push(key);
    },
    () => trust,
  );
  if (retry?.kind !== "answered") throw new Error("expected retry");
  await retry.settled;
  expect(writes).toEqual(["1\r"]);
});

test("C-TRUST-01 cursor navigation does not confirm a replacement dialog under a stale header", async () => {
  const initial = "Do you trust this folder?\n❯ No\n  Yes";
  let frame = initial;
  const writes: string[] = [];
  const result = new TrustPromptResponder("claude", true).handle(
    initial,
    (key) => {
      writes.push(key);
      frame = "Do you trust this folder?\n\nAllow this command?\n❯ Yes\n  No";
    },
    () => frame,
  );
  if (result?.kind !== "answered") throw new Error("expected attempted answer");
  await expect(result.settled).rejects.toThrow("disappeared before confirmation");
  expect(writes).toEqual(["\u001b[B"]);
});
