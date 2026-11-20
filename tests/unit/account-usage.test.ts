/** Public account reads, missing windows and profile isolation (C-STATS-03). */
import { homedir } from "node:os";
import { expect, test, vi } from "vitest";
import { readAccountUsage, type UsageAccount } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";

test("C-STATS-03 checks separate named profiles in caller order, including failed and missing profiles", async () => {
  const profiles: UsageAccount[] = [
    { agent: "codex", label: "Work", configDir: homedir() },
    { agent: "codex", label: "Personal" },
    { agent: "claude", label: "Work" },
    { agent: "claude", label: "missing", configDir: "/no-such-elwood-profile" },
    { agent: "claude", label: "file", configDir: "/etc/hosts" },
  ];
  setCommandRunnerForTests((_cmd, args, options) => {
    const line = args.at(-1)!;
    if (line.includes(homedir()) && options?.env?.["CODEX_HOME"] === homedir())
      return { status: 0, stderr: "", stdout: '{"rateLimits":{"primary":{"usedPercent":12}}}' };
    if (line.includes("lookup") && line.includes("'claude'"))
      return { status: 1, stderr: "private details", stdout: "" };
    return { status: 0, stdout: "not json", stderr: "" };
  });
  const results = await readAccountUsage(profiles);
  expect(results.map(({ agent, label, status }) => [agent, label, status])).toEqual(
    profiles.map(({ agent, label }, i) => [agent, label, i === 0 ? "available" : "unavailable"]),
  );
  expect(results[0]?.windows[0]?.remainingPercent).toBe(88);
  expect(JSON.stringify(results)).not.toContain("private details");
  setCommandRunnerForTests(() => ({
    status: 0,
    stdout: "",
    stderr: "",
    error: { message: "timeout" },
  }));
  expect((await readAccountUsage()).map((r) => r.status)).toEqual(["unavailable", "unavailable"]);
});

const workAccount = { agent: "claude", label: "Work" } as const;
test.each([
  { label: "duplicate name", profiles: [workAccount, workAccount] },
  { label: "unknown agent", profiles: [{ ...workAccount, agent: "other" }] },
  { label: "blank label", profiles: [{ ...workAccount, label: " " }] },
  { label: "relative directory", profiles: [{ ...workAccount, configDir: "relative" }] },
])("C-STATS-03 rejects $label before launching a CLI", async ({ profiles }) => {
  const run = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
  setCommandRunnerForTests(run);
  await expect(readAccountUsage(profiles as UsageAccount[])).rejects.toThrow(TypeError);
  expect(run).not.toHaveBeenCalled();
});

test("C-STATS-03 an explicitly empty account list returns no readings", async () => {
  expect(await readAccountUsage([])).toEqual([]);
});

test("C-STATS-03 each refresh asks the account again and discards a previous reading on failure", async () => {
  const account = [{ agent: "codex", label: "Work" }] as const;
  const replies = [20, 50, null];
  setCommandRunnerForTests(() => ({
    status: 0,
    stderr: "",
    stdout: JSON.stringify({ rateLimits: { primary: { usedPercent: replies.shift() } } }),
  }));
  const read = async () => (await readAccountUsage(account))[0]!;
  expect((await read()).windows[0]?.remainingPercent).toBe(80);
  expect((await read()).windows[0]?.remainingPercent).toBe(50);
  expect(await read()).toMatchObject({ status: "unavailable", windows: [] });
});

test("C-STATS-03 editing a profile during a read cannot relabel another account's balance", async () => {
  const profile = { agent: "codex" as const, label: "Work", configDir: homedir() };
  let selected: string | undefined;
  setCommandRunnerForTests((_cmd, _args, options) => {
    selected = options?.env?.["CODEX_HOME"];
    return { status: 0, stderr: "", stdout: '{"rateLimits":{"primary":{"usedPercent":12}}}' };
  });
  const result = readAccountUsage([profile]);
  profile.configDir = "/elsewhere";
  profile.label = "Personal";
  expect((await result)[0]).toMatchObject({ label: "Work", status: "available" });
  expect(selected).toBe(homedir());
});

test("C-STATS-03 a named profile can supply its directory through a getter", async () => {
  class WorkProfile {
    readonly agent = "codex" as const;
    readonly label = "Work";
    get configDir() {
      return homedir();
    }
  }
  setCommandRunnerForTests((_cmd, _args, options) => ({
    status: 0,
    stderr: "",
    stdout: JSON.stringify({
      rateLimits: {
        primary: { usedPercent: options?.env?.["CODEX_HOME"] === homedir() ? 12 : 80 },
      },
    }),
  }));
  expect((await readAccountUsage([new WorkProfile()]))[0]?.windows[0]?.usedPercent).toBe(12);
});
