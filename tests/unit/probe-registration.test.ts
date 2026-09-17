/** Registration timeouts retain ownership and never release an expired gate (PRD §9.2). */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { runProbe, setProbeTimeoutMsForTests } from "../../src/runtime/probe.ts";
import { spawnProbe } from "../../src/runtime/probe-spawn.ts";
import { ProbeRegistration } from "../../src/runtime/update/probe-registration.ts";
import { tempDir } from "../helpers/tmp.ts";

test("C-PERF-04 a delayed registrar cannot reopen a timed-out gate or release its lease early", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const registry = new ProbeRegistration(() => pending);
  const path = join(tempDir("elwood-registration-"), "mutated");
  setProbeTimeoutMsForTests(50);
  const result = await registry.run(() =>
    runProbe(process.execPath, [
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(path)}, 'bad')`,
    ]),
  );
  expect(result.error?.code).toBe("ETIMEDOUT");
  const release = vi.fn(() => Promise.resolve());
  await registry.release(release);
  expect(release).not.toHaveBeenCalled();
  finish();
  await expect.poll(() => release.mock.calls.length).toBe(1);
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("C-PERF-04 failed registration still releases after settlement and contains cleanup errors", async () => {
  let reject!: (error: Error) => void;
  const registry = new ProbeRegistration(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const operation = registry.register(1, new AbortController().signal);
  const release = vi.fn(() => Promise.reject(new Error("cleanup")));
  await registry.release(release);
  reject(new Error("registration"));
  await expect(operation).rejects.toThrow("registration");
  await expect.poll(() => release.mock.calls.length).toBe(1);
});

test("C-PERF-04 a gate pipe error is owned before a registration can complete", async () => {
  let finish!: () => void;
  const registry = new ProbeRegistration(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  await registry.run(async () => {
    const { child, open } = spawnProbe(
      process.execPath,
      ["-e", "process.exit()"],
      controller.signal,
    );
    await new Promise<void>((resolve) => child.once("spawn", resolve));
    const rejected = expect(open).rejects.toThrow("broken pipe");
    controller.abort();
    child.stdin.destroy(new Error("broken pipe"));
    await rejected;
    finish();
    child.kill("SIGKILL");
  });
});

test("C-PERF-04 a gate reader closing after registration cannot report a successful write", async () => {
  let finish!: () => void;
  const registry = new ProbeRegistration(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await registry.run(async () => {
    const { child, open } = spawnProbe(
      process.execPath,
      ["-e", "process.exit()"],
      new AbortController().signal,
    );
    await new Promise<void>((resolve) => child.once("spawn", resolve));
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGKILL");
    await closed;
    const rejected = expect(open).rejects.toBeInstanceOf(Error);
    finish();
    await rejected;
  });
});
