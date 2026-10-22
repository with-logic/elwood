/** Paint failures and cleanup retain owned transaction lifetimes (PRD §4). */
import { expect, test, vi } from "vitest";
import { transactionBinding } from "./owned-transaction-helpers.ts";
import { createOwnedInteraction } from "./owned-transaction-interaction.ts";
import { setupOwnedScenario } from "./owned-transaction-scenario.ts";

test("observes asynchronous paint failures and revokes the owning transaction signal", async () => {
  const closing = new AbortController();
  const scenario = setupOwnedScenario({ mode: "queued", long: false, wrong: false });
  const interaction = createOwnedInteraction(scenario, closing);
  const failure = new Error("Owned terminal paint failed");
  vi.spyOn(interaction.terminal, "writeOutput").mockRejectedValueOnce(failure);
  try {
    await interaction.terminal.sendInput("\t");
    await expect(interaction.waitForAcknowledgement()).rejects.toBe(failure);
    expect(closing.signal.aborted).toBe(true);
    expect(closing.signal.reason).toBe(failure);
    await expect(interaction.settled()).rejects.toBe(failure);
    expect(interaction.canAcknowledge()).toBe(false);
  } finally {
    closing.abort();
    interaction.terminal.dispose();
  }
});

test("cleanup drains the caller while native acknowledgement retains its reservation", async () => {
  const h = await transactionBinding({ mode: "queued", long: false, wrong: false });
  await h.waitForAcknowledgement();
  expect(h.transaction.busy()).toBe(true);
  let disposed = false;
  const disposing = h.dispose().then(() => {
    disposed = true;
  });
  await expect.poll(() => disposed, { timeout: 500 }).toBe(true);
  await disposing;
  expect(await h.result).toBe("failed");
  expect(h.transaction.busy()).toBe(true);
  expect(h.registry.keyFor(h.request.id)).toBeDefined();
  h.acknowledge();
  expect(h.transaction.busy()).toBe(false);
  expect(h.events.filter((event) => event.phase === "closed")).toHaveLength(1);
  expect(h.events.at(-1)).toMatchObject({ phase: "closed", reason: "unavailable" });
});
