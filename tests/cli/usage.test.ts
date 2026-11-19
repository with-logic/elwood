/** Account usage through the normal CLI, including saved defaults (C-STATS-03). */
import { join } from "node:path";
import { expect, test, vi } from "vitest";
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
  stdout:
    '{"rate_limits_available":true,"rate_limits":{"seven_day":{"utilization":25,"resets_at":"2028-02-01T10:15:00Z"}}}',
  stderr: "",
};

test("C-STATS-03 before launch, the CLI defaults left, saves used, and allows a one-time override", async () => {
  const h = harness();
  setCommandRunnerForTests(() => valid);
  const args = ["usage", "--account", "claude:Work"];
  expect(await h.run(args)).toBe(0);
  expect(h.stdout.value).toMatch(/LEFT[\s\S]*Work\s+Weekly\s+75%\s+2028-02-01T10:15:00Z/);
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
  const active = Promise.withResolvers<typeof valid>();
  const started = Promise.withResolvers<void>();
  setCommandRunnerForTests(() => {
    started.resolve();
    return active.promise;
  });
  const done = vi.fn();
  const pending = h.run(["usage", "--output", "json"]).then((status) => {
    done(status);
    return status;
  });
  await started.promise;
  h.context.signals.emit();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(done).not.toHaveBeenCalled();
  active.resolve(valid);
  expect(await pending).toBe(130);
  expect(h.stdout.value).toBe("");
  expect(h.context.signals.unbound).toBe(true);
});

test("C-STATS-03 usage validates help position and suggests its own options", async () => {
  const h = harness();
  expect(await h.run(["usage", "--", "--help"])).toBe(2);
  expect(await h.run(["usage", "--acount", "claude:Work"])).toBe(2);
  expect(h.stderr.value).toContain("Did you mean '--account'?");
});

test("C-STATS-03 structured usage strips controls from profile labels", async () => {
  const h = harness();
  setCommandRunnerForTests(() => valid);
  expect(await h.run(["usage", "--account", "claude:\u009b31mWork", "--output", "json"])).toBe(0);
  expect(JSON.parse(h.stdout.value).accounts[0].label).toBe("Work");
});

test("C-STATS-03 usage releases the SIGINT handler before a slow write", async () => {
  const h = harness();
  setCommandRunnerForTests(() => ({
    ...valid,
    stdout: valid.stdout.replace(',"resets_at":"2028-02-01T10:15:00Z"', ""),
  }));
  const write = h.stdout.write.bind(h.stdout);
  vi.spyOn(h.stdout, "write").mockImplementation((text, callback) => {
    expect(h.context.signals.unbound).toBe(true);
    return write(text, callback);
  });
  expect(await h.run(["usage", "--account", "claude:Work"])).toBe(0);
});

test("C-STATS-03 usage errors apply to the command, even with a saved agent hint", async () => {
  const h = harness();
  expect(
    await main(["usage", "--direction", "bad", "--output", "json"], {
      ...h.context,
      env: { ...h.context.env, ELWOOD_AGENT: "claude" },
    }),
  ).toBe(2);
  expect(JSON.parse(h.stdout.value).agent).toBeNull();
});
