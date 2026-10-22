/** Chrome-shaped owned answer text must retain its native question identity (PRD §4). */
import { expect, test } from "vitest";
import { transactionBinding } from "./owned-transaction-helpers.ts";

const probes = [
  { mode: "queued", text: "A\n    › 1. task", name: "continuation caret" },
  { mode: "queued", text: "› 1. task", name: "first-line caret" },
  { mode: "modal", text: "A\n  Question 1/2 (2 unanswered)\n  B", name: "indented header" },
  { mode: "modal", text: "A\nQuestion 1/2 (2 unanswered)\nB", name: "header" },
] as const;
test.each(
  probes.flatMap((probe) => [
    { ...probe, wrong: false },
    { ...probe, wrong: true },
  ]),
)("$mode owned $name submits once and verifies native values (wrong=$wrong)", async ({
  mode,
  text,
  wrong,
}) => {
  const h = await transactionBinding({
    mode,
    long: false,
    wrong,
    probe: { text, timeoutMs: 3000 },
  });
  const pastes = () => h.writes.filter((input) => input.startsWith("\x1b[200~"));
  const enters = () => h.writes.filter((input) => input === "\r");
  await expect.poll(pastes).toEqual([`\x1b[200~${text}\x1b[201~`]);
  await expect.poll(enters, { timeout: 2500 }).toEqual(["\r"]);
  await h.waitForAcknowledgement();
  expect(h.canAcknowledge()).toBe(true);
  expect(h.transaction.busy()).toBe(true);
  h.acknowledge();
  expect(await h.result).toBe(wrong ? "failed" : "answered");
  expect(h.events.at(-1)).toMatchObject({
    phase: "closed",
    reason: wrong ? "unavailable" : "answered",
  });
});
