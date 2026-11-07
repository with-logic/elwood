/** Native shutdown readers obey the process-wide admission bound (C-LIFE-10). */
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { psRunOptions, runFile } from "../../../src/runtime/shutdown/process-table.ts";
import { runFileUnreferenced } from "../../../src/runtime/shutdown/unreferenced-read.ts";
import { killIfCommandHas, pidExists } from "../../helpers/process-liveness.ts";
import { tempDir } from "../../helpers/tmp.ts";

const HOLD = `
const { writeFileSync, existsSync } = require("node:fs");
const dir = process.argv[1];
writeFileSync(dir + "/" + process.pid, "");
const wait = () => existsSync(dir + "/release") ? process.exit(0) : setTimeout(wait, 5);
wait();
`;

test.each([
  { label: "foreground", mixed: false },
  { label: "mixed foreground and background", mixed: true },
])("C-LIFE-10 eight $label native readers hold at most two live subprocesses", async ({
  mixed,
}) => {
  const dir = tempDir("elwood-native-read-bound-");
  const pids = () =>
    readdirSync(dir)
      .filter((name) => /^\d+$/.test(name))
      .map(Number);
  const liveCount = () => pids().filter(pidExists).length;
  const requests = Array.from({ length: 8 }, (_, index) =>
    (mixed && index % 2 !== 0 ? runFileUnreferenced : runFile)(
      process.execPath,
      ["-e", HOLD, dir],
      psRunOptions(5_000),
    ),
  );
  const settled = Promise.allSettled(requests);
  let peak = 0;
  const observe = () => {
    peak = Math.max(peak, liveCount());
  };
  const observing = setInterval(observe, 10);
  let outcomes: Awaited<typeof settled> = [];
  try {
    await vi.waitFor(() => expect(liveCount()).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    // The native children stay alive behind a file barrier throughout this observation.
    await delay(150);
    observe();
    expect(peak).toBe(2); // The documented default, independently of the implementation constant.
  } finally {
    writeFileSync(join(dir, "release"), "");
    outcomes = await settled;
    clearInterval(observing);
    for (const pid of pids()) killIfCommandHas(pid, dir);
  }
  expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
  expect(peak).toBe(2);
});

test("C-LIFE-10 a native spawn failure releases admission for later readers", async () => {
  await expect(runFile("/elwood-no-such-reader", [], psRunOptions(1_000))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    runFile(process.execPath, ["-e", "process.stdout.write('fresh')"], psRunOptions(1_000)),
  ).resolves.toMatchObject({ stdout: "fresh" });
});
