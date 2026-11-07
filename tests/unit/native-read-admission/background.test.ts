/** Foreground and unreferenced recovery readers share one native cap (C-LIFE-10). */
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

test("C-LIFE-10 mixed foreground and background reads share two native slots", async () => {
  const dir = tempDir("elwood-mixed-native-read-");
  const pids = () =>
    readdirSync(dir)
      .filter((name) => /^\d+$/.test(name))
      .map(Number);
  const liveCount = () => pids().filter(pidExists).length;
  const requests = Array.from({ length: 8 }, (_, index) =>
    (index % 2 === 0 ? runFile : runFileUnreferenced)(
      process.execPath,
      ["-e", HOLD, dir],
      psRunOptions(5_000),
    ),
  );
  const settled = Promise.allSettled(requests);
  try {
    await vi.waitFor(() => expect(liveCount()).toBe(2));
    await delay(100);
    expect(pids()).toHaveLength(2);
  } finally {
    writeFileSync(join(dir, "release"), "");
    const outcomes = await settled;
    for (const pid of pids()) killIfCommandHas(pid, dir);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
  }
});
