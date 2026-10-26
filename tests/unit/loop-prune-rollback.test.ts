/**
 * A launch's loop prunes roll back with its other publications, and only its own: the prune its
 * activation makes before failing is restored, and a predecessor's prune of the same loop stands
 * (PRD §8.1, §9.3, C-API-20, C-LOOP-13).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { LOOP_EXPIRATION_MS } from "../../src/core/loops/constants.ts";
import { loadRuntimeLoopDefinitions } from "../../src/runtime/loop-restore.ts";
import { SessionLoops } from "../../src/runtime/session/loops.ts";
import {
  type LaunchReservation,
  reserveLaunchOwnership,
} from "../../src/state/launch-ownership.ts";
import { writeLoopDefinitions } from "../../src/state/loop-store.ts";
import { readLoopDefinitions } from "../helpers/loops.ts";
import { tempDir } from "../helpers/tmp.ts";

const failure = vi.hoisted(() => ({ directoryFsync: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      if (failure.directoryFsync && actual.fstatSync(fd).isDirectory())
        throw new Error("directory fsync failed");
      actual.fsyncSync(fd);
    },
  };
});
afterEach(() => {
  failure.directoryFsync = false;
  vi.useRealTimers();
});

const NOW = 1_800_000_000_000;
const id = "loop-prune-rollback";

/** A session whose loop "soon" expires one second after NOW; returns its paths. */
function sessionWithLoops() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const stateDir = tempDir();
  const sessionDir = join(stateDir, "sessions", id);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const timing = { intervalMs: 60_000, jitterMs: 0 } as const;
  const expiring = (loopId: string, expiresAt: number) => {
    const createdAt = expiresAt - LOOP_EXPIRATION_MS;
    return {
      id: loopId,
      message: "check",
      mode: "fixed",
      ...timing,
      createdAt,
      expiresAt,
    } as const;
  };
  writeLoopDefinitions(stateDir, id, [expiring("soon", NOW + 1000), expiring("live", NOW + 9e6)]);
  return { stateDir, sessionDir, sidecar: join(sessionDir, "loops.json") };
}

/** The loops of a launch that owns `ownership`, as a session builds them. */
function sessionLoops(stateDir: string, ownership: LaunchReservation): SessionLoops {
  const queue = new ControlQueue(
    () => Promise.resolve(),
    () => new Error("closed"),
    () => undefined,
  );
  const definitions = readLoopDefinitions(stateDir, id);
  const emitter = { emit: () => undefined };
  return new SessionLoops({
    stateDir,
    elwoodSessionId: id,
    ownership,
    queue,
    definitions,
    emitter,
  });
}

test("C-API-20 C-LOOP-13 a launch restores the prune its activation made before failing", () => {
  const { stateDir, sessionDir, sidecar } = sessionWithLoops();
  const before = readFileSync(sidecar, "utf8");
  const launch = reserveLaunchOwnership(sessionDir);
  sessionLoops(stateDir, launch);
  vi.setSystemTime(NOW + 1000);
  failure.directoryFsync = true;
  expect(() => launch.commit()).toThrowError(
    expect.objectContaining({ code: "loop_persistence_failed", details: { loopId: "soon" } }),
  );
  failure.directoryFsync = false;
  // The prune failed after its rename, so the sidecar on disk is the pruned one.
  expect(readLoopDefinitions(stateDir, id).map((loop) => loop.id)).toEqual(["live"]);
  launch.rollback();
  expect(readFileSync(sidecar, "utf8")).toBe(before);
});

test("C-API-20 a predecessor's prune stands when a resume that made the same prune fails", () => {
  const { stateDir, sessionDir, sidecar } = sessionWithLoops();
  const prior = reserveLaunchOwnership(sessionDir);
  const priorLoops = sessionLoops(stateDir, prior);
  prior.commit();
  priorLoops.pause();
  vi.setSystemTime(NOW + 1000);
  const resume = reserveLaunchOwnership(sessionDir);
  try {
    loadRuntimeLoopDefinitions(stateDir, id, resume.publishFile);
    const pruned = readFileSync(sidecar, "utf8");
    // The stopped predecessor prunes the same loop, writing the bytes the resume wrote.
    expect(priorLoops.list().map((loop) => loop.id)).toEqual(["live"]);
    expect(readFileSync(sidecar, "utf8")).toBe(pruned);
    resume.rollback();
    expect(readFileSync(sidecar, "utf8")).toBe(pruned);
  } finally {
    prior.release();
  }
});
