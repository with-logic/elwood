/** Account usage through the normal CLI, including saved defaults (C-STATS-03). */
import { writeFileSync } from "node:fs";
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
  stdout: JSON.stringify({
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 60, resets_at: "2028-02-01T08:00:00Z" },
      seven_day: { utilization: 25, resets_at: "2028-02-01T10:15:00Z" },
    },
  }),
  stderr: "",
};

test("C-STATS-03 before launch, the CLI defaults left, saves used, and allows a one-time override", async () => {
  const h = harness();
  setCommandRunnerForTests(() => valid);
  const args = ["usage", "--account", "claude:Work"];
  expect(await h.run(args)).toBe(0);
  expect(
    h.stdout.value
      .trimEnd()
      .split("\n")
      .map((line) => line.trim().split(/\s+/u)),
  ).toEqual([
    ["AGENT", "ACCOUNT", "WINDOW", "LEFT", "RESETS", "AT"],
    ["claude", "Work", "5-hour", "40%", "2028-02-01T08:00:00Z"],
    ["claude", "Work", "Weekly", "75%", "2028-02-01T10:15:00Z"],
  ]);
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
    schemaVersion: 1,
    type: "usage",
    accounts: [
      {
        agent: "claude",
        windows: [
          {
            label: "5-hour",
            windowMinutes: 300,
            usedPercent: 60,
            remainingPercent: 40,
            resetsAt: "2028-02-01T08:00:00Z",
          },
          {
            label: "Weekly",
            windowMinutes: 10080,
            usedPercent: 25,
            remainingPercent: 75,
            resetsAt: "2028-02-01T10:15:00Z",
          },
        ],
      },
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

test.each([
  "--help",
  "-h",
])("C-STATS-03 %s works with an invalid config and skips probes", async (flag) => {
  const h = harness();
  writeFileSync(h.context.env.ELWOOD_CONFIG, "{", { mode: 0o600 });
  const probe = vi.fn(() => valid);
  setCommandRunnerForTests(probe);
  expect(await h.run(["usage", flag])).toBe(0);
  expect(h.stdout.value).toContain("elwood usage");
  expect(probe).not.toHaveBeenCalled();
});

test.each([
  { args: ["--account", "bad"] },
  { args: ["--account", "unknown:Work"] },
  { args: ["--account", "codex:Me=relative"] },
  { args: ["--direction", "up"] },
  { args: ["--output", "jsonl"] },
  { args: ["prompt"] },
])("C-STATS-03 rejects invalid usage args $args before probing", async ({ args }) => {
  const h = harness();
  const probe = vi.fn(() => valid);
  setCommandRunnerForTests(probe);
  expect(await h.run(["usage", ...args])).toBe(2);
  expect(probe).not.toHaveBeenCalled();
});

test("C-STATS-03 interruption drains an active read and releases the signal handler", async () => {
  const h = harness();
  const active = Promise.withResolvers<typeof valid>();
  const started = Promise.withResolvers<AbortSignal | undefined>();
  setCommandRunnerForTests((_cmd, _args, options) => {
    started.resolve(options?.signal);
    return active.promise;
  });
  const done = vi.fn();
  const pending = h.run(["usage", "--output", "json"]).then((status) => {
    done(status);
    return status;
  });
  const signal = await started.promise;
  expect(signal?.aborted).toBe(false);
  h.context.signals.emit();
  expect(signal?.aborted).toBe(true);
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

test.each([
  "text",
  "json",
])("C-STATS-03 %s strips controls from account and provider window labels", async (output) => {
  const h = harness();
  setCommandRunnerForTests(() => ({
    ...valid,
    stdout: JSON.stringify({
      rate_limits_available: true,
      rate_limits: { model_scoped: [{ display_name: "\u009b31mOpus", utilization: 20 }] },
    }),
  }));
  expect(await h.run(["usage", "--account", "claude:\u009b31mWork", "--output", output])).toBe(0);
  expect(h.stdout.value).toMatch(/\bWork\b/u);
  expect(h.stdout.value).toContain("Weekly (Opus)");
  expect(h.stdout.value).not.toContain("\u009b");
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

test("C-STATS-03 usage errors apply to the command, even with an environment agent hint", async () => {
  const h = harness();
  expect(
    await main(["usage", "--direction", "bad", "--output", "json"], {
      ...h.context,
      env: { ...h.context.env, ELWOOD_AGENT: "claude" },
    }),
  ).toBe(2);
  expect(JSON.parse(h.stdout.value).agent).toBeNull();
});
