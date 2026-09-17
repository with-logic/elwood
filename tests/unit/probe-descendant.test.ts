/** Real descendant ownership survives direct-child and owner exits (PRD §9.2). */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { runProbe, setProbeTimeoutMsForTests } from "../../src/runtime/probe.ts";
import { processGroupGone } from "../../src/runtime/probe-cleanup.ts";
import { coordinatedAutoupdate } from "../../src/runtime/update/lock.ts";
import { tempDir } from "../helpers/tmp.ts";

const fixture = fileURLToPath(new URL("../fixtures/probe-descendant.ts", import.meta.url));
const execute = promisify(execFile);
const kill = process.kill.bind(process);
afterEach(() => vi.restoreAllMocks());
const childResult = async (root: string, mode: string) => {
  const { stdout } = await execute(process.execPath, ["--no-warnings", fixture, mode, root], {
    timeout: 10_000,
  });
  return JSON.parse(stdout) as unknown;
};
function cleanup(root: string): void {
  if (!existsSync(join(root, "leader"))) return;
  const pid = Number(readFileSync(join(root, "leader"), "utf8"));
  try {
    kill(-pid, "SIGKILL");
  } catch {}
}

test("C-PERF-04 normal leader exit and parent death keep exclusion until the real group exits", async () => {
  const root = tempDir("elwood-descendant-");
  try {
    await expect(childResult(root, "owner")).resolves.toMatchObject({
      result: "skipped",
      details: { cleanupErrorCode: "ETIMEDOUT" },
    });
    const group = Number(readFileSync(join(root, "leader"), "utf8"));
    expect(processGroupGone(group)).toBe(false);
    await expect(childResult(root, "contender")).resolves.toMatchObject({
      result: "skipped",
      details: { updateReason: "active_owner" },
    });
    expect(existsSync(join(root, "mutated"))).toBe(false);
    kill(Number(readFileSync(join(root, "descendant"), "utf8")), "SIGTERM");
    await expect.poll(() => processGroupGone(group)).toBe(true);
    await expect(childResult(root, "contender")).resolves.toEqual({ result: "updated" });
    expect(readFileSync(join(root, "mutated"), "utf8")).toBe("once");
  } finally {
    cleanup(root);
  }
});

test("C-PERF-03 a failed version/help probe reaps its real surviving descendant after returning", async () => {
  const root = tempDir("elwood-probe-reaper-");
  setProbeTimeoutMsForTests(1_500);
  const intervals = vi.spyOn(globalThis, "setInterval");
  const cleared = vi.spyOn(globalThis, "clearInterval");
  let allowGroupSignal = false;
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid < 0 && signal === "SIGKILL" && !allowGroupSignal)
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    return kill(pid, signal);
  });
  try {
    const result = await runProbe(process.execPath, ["--no-warnings", fixture, "linger", root]);
    expect(result.error).toMatchObject({ code: "ETIMEDOUT", cleanupErrorCode: "EPERM" });
    const group = Number(readFileSync(join(root, "leader"), "utf8"));
    expect(result.error?.cleanupProcessGroup).toBe(group);
    expect(processGroupGone(group)).toBe(false);
    const timer = intervals.mock.results.at(-1)?.value;
    expect(timer.hasRef()).toBe(false);
    allowGroupSignal = true;
    await expect.poll(() => processGroupGone(group), { timeout: 4_000 }).toBe(true);
    await expect
      .poll(() => cleared.mock.calls.some(([value]) => value === timer), { timeout: 2_000 })
      .toBe(true);
  } finally {
    cleanup(root);
  }
});

test("C-PERF-04 a normal in-process update retains its group after direct-child success", async () => {
  const root = tempDir("elwood-local-descendant-");
  try {
    await expect(
      coordinatedAutoupdate(
        "codex",
        async () => {
          const result = await runProbe(process.execPath, [
            "--no-warnings",
            fixture,
            "leader",
            root,
          ]);
          expect(result.status).toBe(0);
        },
        { root },
      ),
    ).rejects.toMatchObject({
      details: { cleanupErrorCode: "ETIMEDOUT" },
    });
    expect(processGroupGone(Number(readFileSync(join(root, "leader"), "utf8")))).toBe(false);
  } finally {
    cleanup(root);
  }
});
