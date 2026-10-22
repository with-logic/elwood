/** Native logical acknowledgement resolves or rejects real owned transactions (PRD §4). */
import { expect, test } from "vitest";
import { expected } from "./owned-fixtures.ts";
import { transactionBinding } from "./owned-transaction-helpers.ts";
import { unreachableMode } from "./owned-transaction-scenario.ts";

test.each([
  ["queued", false, false],
  ["queued", false, true],
  ["queued", true, false],
  ["queued", true, true],
  ["modal", true, false],
  ["modal", true, true],
] as const)("real %s transaction verifies full native values and whitespace (long=%s wrong=%s)", async (mode, long, wrong) => {
  const h = await transactionBinding({ mode, long, wrong });
  await h.waitForAcknowledgement();
  expect(h.canAcknowledge()).toBe(true);
  expect(h.transaction.busy()).toBe(true);
  h.acknowledge();
  expect(await h.result).toBe(wrong ? "failed" : "answered");
  expect(h.events.at(-1)).toMatchObject({
    phase: "closed",
    reason: wrong ? "unavailable" : "answered",
  });
  switch (mode) {
    case "queued":
      expect(h.writes.filter((input) => input === "\r")).toHaveLength(1);
      expect(h.writes.filter((input) => input.startsWith("\x1b[200~"))).toEqual([
        `\x1b[200~${long ? h.values.long : h.values.literal}\x1b[201~`,
      ]);
      break;
    case "modal":
      expect(h.writes.filter((input) => input === "\r")).toHaveLength(2);
      expect(h.writes.filter((input) => input.startsWith("\x1b[200~"))).toEqual([
        `\x1b[200~${h.values.literal}\x1b[201~`,
        `\x1b[200~${h.values.long}\x1b[201~`,
      ]);
      break;
    default:
      unreachableMode(mode);
  }
});

test.each([
  { mode: "queued", mismatch: "missing tail" },
  { mode: "queued", mismatch: "altered tail" },
  { mode: "modal", mismatch: "missing tail" },
  { mode: "modal", mismatch: "altered tail" },
] as const)("real $mode transaction rejects a long native answer with $mismatch", async ({
  mode,
  mismatch,
}) => {
  const complete = expected(mode).long.trim();
  const prefix = complete.slice(0, -1);
  const nativeText = mismatch === "missing tail" ? prefix : `${prefix}X`;
  expect(prefix.length).toBeGreaterThan(700);
  expect(nativeText.startsWith(prefix)).toBe(true);
  const h = await transactionBinding({ mode, long: true, wrong: false, nativeText });
  await h.waitForAcknowledgement();
  expect(h.canAcknowledge()).toBe(true);
  expect(h.transaction.busy()).toBe(true);
  h.acknowledge();
  expect(await h.result).toBe("failed");
  expect(h.events.at(-1)).toMatchObject({ phase: "closed", reason: "unavailable" });
});
