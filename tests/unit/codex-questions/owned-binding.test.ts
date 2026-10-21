/** Native logical acknowledgement resolves or rejects real owned transactions (PRD §4). */
import { expect, test } from "vitest";
import { transactionBinding } from "./owned-transaction-helpers.ts";

test.each([
  ["queued", false, false],
  ["queued", false, true],
  ["queued", true, false],
  ["queued", true, true],
  ["modal", true, false],
  ["modal", true, true],
] as const)("real %s transaction verifies full native values and whitespace (long=%s wrong=%s)", async (mode, long, wrong) => {
  const h = await transactionBinding({ mode, long, wrong });
  await expect.poll(h.acknowledge, { timeout: 2500 }).toBeTypeOf("function");
  expect(h.transaction.busy()).toBe(true);
  h.acknowledge()!();
  expect(await h.result).toBe(wrong ? "failed" : "answered");
  expect(h.events.at(-1)).toMatchObject({
    phase: "closed",
    reason: wrong ? "unavailable" : "answered",
  });
  expect(h.writes.filter((input) => input === "\r")).toHaveLength(mode === "modal" ? 2 : 1);
  expect(h.writes.filter((input) => input.startsWith("\x1b[200~"))).toEqual(
    mode === "modal"
      ? [`\x1b[200~${h.values.literal}\x1b[201~`, `\x1b[200~${h.values.long}\x1b[201~`]
      : [`\x1b[200~${long ? h.values.long : h.values.literal}\x1b[201~`],
  );
});
