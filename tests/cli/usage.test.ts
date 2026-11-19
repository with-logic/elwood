/** Account usage through the normal CLI, including saved defaults (C-STATS-03). */
import { join } from "node:path";
import { expect, test } from "vitest";
import { main } from "../../src/cli/main.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { tempDir } from "../helpers/tmp.ts";
import { mainHarness } from "./main-fakes.ts";
import { FakeSignals } from "./run-fakes.ts";

function harness() {
  const h = mainHarness();
  const env = { ELWOOD_CONFIG: join(tempDir("quota-config-"), "config.json") };
  const context = { ...h.context, env, signals: new FakeSignals() };
  return { ...h, context, run: (args: string[]) => main(args, context) };
}
const valid = {
  status: 0,
  stdout: '{"rate_limits_available":true,"rate_limits":{"seven_day":{"utilization":25}}}',
  stderr: "",
};

test("C-STATS-03 before launch, the CLI defaults left, saves used, and allows a one-time override", async () => {
  const h = harness();
  setCommandRunnerForTests(() => valid);
  const args = ["usage", "--account", "claude:Work"];
  expect(await h.run(args)).toBe(0);
  expect(h.stdout.value).toMatch(/LEFT[\s\S]*Work\s+Weekly\s+75%/);
  expect(await h.run(["config", "set", "usageDirection", "used"])).toBe(0);
  h.stdout.value = "";
  expect(await h.run(args)).toBe(0);
  expect(h.stdout.value).toMatch(/USED[\s\S]*25%/);
  h.stdout.value = "";
  expect(
    await h.run([...args, "--direction", "left", "--account", "codex:Personal=/etc/hosts"]),
  ).toBe(1);
  expect(h.stdout.value).toMatch(/LEFT[\s\S]*Work\s+Weekly\s+75%[\s\S]*Personal\s+Unavailable/);
  expect(await h.run(["config", "set", "usageDirection", "up"])).toBe(2);
});

test("C-STATS-03 JSON retains both accounts on partial failure and accepts the configured output", async () => {
  const h = harness();
  setCommandRunnerForTests(() => valid);
  expect(await h.run(["config", "set", "output", "json"])).toBe(0);
  h.stdout.value = "";
  expect(await h.run(["usage"])).toBe(1);
  expect(JSON.parse(h.stdout.value)).toMatchObject({
    type: "usage",
    accounts: [
      { agent: "claude", windows: [{ label: "Weekly", remainingPercent: 75 }] },
      { agent: "codex", status: "unavailable", windows: [] },
    ],
  });
  h.stdout.value = "";
  expect(
    await main(["usage", "--account", "claude:Work"], {
      ...h.context,
      env: { ...h.context.env, ELWOOD_OUTPUT: "text" },
    }),
  ).toBe(0);
  expect(h.stdout.value).toContain("LEFT");
});

test("C-STATS-03 help and invalid usage arguments do not probe accounts", async () => {
  const h = harness();
  let calls = 0;
  setCommandRunnerForTests(() => {
    calls++;
    return valid;
  });
  for (const help of ["--help", "-h"]) expect(await h.run(["usage", help])).toBe(0);
  for (const args of [
    ["--account", "bad"],
    ["--account", "codex:Me=relative"],
    ["--direction", "up"],
    ["--output", "jsonl"],
    ["prompt"],
  ]) {
    expect(await h.run(["usage", ...args])).toBe(2);
  }
  expect(calls).toBe(0);
});

test("C-STATS-03 interruption drains an active read and releases the signal handler", async () => {
  const h = harness();
  setCommandRunnerForTests(() => {
    h.context.signals.emit();
    return valid;
  });
  expect(await h.run(["usage", "--output", "json"])).toBe(130);
  expect(h.stdout.value).toBe("");
  expect(h.context.signals.unbound).toBe(true);
});
