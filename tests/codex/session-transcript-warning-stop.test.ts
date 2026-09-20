/** Transcript diagnostics finish fan-out before reentrant exit (PRD §5.7, C-API-20). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { becomeReady, installFakes, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-API-20 a transcript warning finishes delivery before listener-initiated shutdown", async () => {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "rollout.jsonl");
  writeFileSync(path, "");
  const session = await startCodex({ cwd });
  const order: string[] = [];
  let stopped: Promise<void> | undefined;
  session.on("warning", (event) => {
    if (event.code !== "transcript_records_dropped") return;
    order.push("warning:first");
    stopped ??= session.stop();
  });
  session.on("warning", (event) => {
    if (event.code === "transcript_records_dropped") order.push("warning:second");
  });
  session.on("activity", (event) => {
    if (event.kind === "warning") order.push("warning:activity");
  });
  session.on("terminal:exit", () => order.push("exit"));
  try {
    await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
    appendFileSync(path, "malformed\n");
    await expect.poll(() => order.includes("exit")).toBe(true);
    expect(stopped).toBeDefined();
    await expect(stopped).resolves.toBeUndefined();
    expect(order).toEqual(["warning:first", "warning:second", "warning:activity", "exit"]);
  } finally {
    await session.stop();
  }
});

test("C-API-20 buffered startup diagnostics finish delivery before listener-initiated shutdown", async () => {
  installFakes();
  setCommandRunnerForTests((_command, args) => ({
    status: 0,
    stdout: args.includes("--help") ? "--dangerously-bypass-hook-trust" : "unknown build",
    stderr: "",
  }));
  const session = await startCodex({ cwd: tempDir() });
  const order: string[] = [];
  let stopped: Promise<void> | undefined;
  session.on("warning", () => {
    order.push("warning:first");
    stopped ??= session.stop();
  });
  session.on("warning", () => order.push("warning:second"));
  session.on("activity", (event) => {
    if (event.kind === "warning") order.push("warning:activity");
  });
  session.on("terminal:exit", () => order.push("exit"));
  session.on("status", (event) => {
    if (event.status === "stopped") order.push("status");
  });
  try {
    await expect.poll(() => order.includes("exit")).toBe(true);
    expect(stopped).toBeDefined();
    await expect(stopped).resolves.toBeUndefined();
    expect(order).toEqual([
      "warning:first",
      "warning:second",
      "warning:activity",
      "exit",
      "status",
    ]);
  } finally {
    await session.stop();
  }
});
