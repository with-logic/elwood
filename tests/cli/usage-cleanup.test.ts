/** Account probe cleanup diagnostics preserve CLI output and statuses (§12A.11, C-STATS-03). */
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { main } from "../../src/cli/main.ts";
import { readAccountUsage } from "../../src/index.ts";
import { type CommandResult, setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { tempDir } from "../helpers/tmp.ts";
import { mainHarness } from "./main-fakes.ts";
import { FakeSignals } from "./run-fakes.ts";

const diagnostic =
  "elwood: could not confirm account usage probe cleanup (EPERM, process group 4242).\n";
const args = ["usage", "--output", "json", "--account", "claude:Work"];
const unavailable = {
  agent: "claude",
  label: "Work",
  status: "unavailable",
  checkedAt: expect.any(String),
  windows: [],
};

function harness() {
  const h = mainHarness();
  const signals = new FakeSignals();
  const env = { ELWOOD_CONFIG: join(tempDir("quota-config-"), "config.json") };
  return { ...h, signals, run: () => main(args, { ...h.context, signals, env }) };
}

function failedProbe(code: string, confirmed = false): CommandResult {
  return {
    status: null,
    stdout: "private provider response",
    stderr: "private shell output",
    error: {
      code,
      message: "private account details",
      ...(confirmed ? {} : { cleanupErrorCode: "EPERM", cleanupProcessGroupId: 4242 }),
    },
  };
}

test.each([
  { confirmed: false, expected: diagnostic },
  { confirmed: true, expected: "" },
])("C-STATS-03 a timed-out usage probe reports only unconfirmed cleanup (confirmed: $confirmed)", async ({
  confirmed,
  expected,
}) => {
  const h = harness();
  setCommandRunnerForTests(() => failedProbe("ETIMEDOUT", confirmed));
  expect(await h.run()).toBe(1);
  expect(JSON.parse(h.stdout.value)).toEqual({
    schemaVersion: 1,
    type: "usage",
    accounts: [unavailable],
  });
  expect(h.stderr.value).toBe(expected);
  expect(await readAccountUsage([{ agent: "claude", label: "Work" }])).toEqual([unavailable]);
});

test("C-STATS-03 Ctrl-C reports unconfirmed usage probe cleanup before the usual status 130", async () => {
  const h = harness();
  const active = Promise.withResolvers<CommandResult>();
  const started = Promise.withResolvers<void>();
  setCommandRunnerForTests(() => {
    started.resolve();
    return active.promise;
  });
  const pending = h.run();
  await started.promise;
  h.signals.emit();
  active.resolve(failedProbe("ABORT_ERR"));
  expect(await pending).toBe(130);
  expect(h.stdout.value).toBe("");
  expect(h.stderr.value).toBe(diagnostic);
  expect(h.signals.unbound).toBe(true);
});

test.each([
  "EPIPE",
  "EIO",
])("C-STATS-03 an unwritable cleanup diagnostic leaves usage JSON and status intact (%s)", async (code) => {
  const h = harness();
  setCommandRunnerForTests(() => failedProbe("ETIMEDOUT"));
  const write = vi.spyOn(h.stderr, "write").mockImplementation((_value, callback) => {
    callback(Object.assign(new Error("stderr failed"), { code }));
    return true;
  });
  expect(await h.run()).toBe(1);
  expect(JSON.parse(h.stdout.value).accounts).toEqual([unavailable]);
  expect(write).toHaveBeenCalledExactlyOnceWith(diagnostic, expect.any(Function));
});
