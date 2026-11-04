/** Failed resume reads/writes must stay in its owned directory (C-API-61, C-LOOP-13). */
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { LOOP_EXPIRATION_MS } from "../../src/core/loops/constants.ts";
import { loadRuntimeLoopDefinitions } from "../../src/runtime/loop-restore.ts";
import { SessionLoops } from "../../src/runtime/session/loops.ts";
import { secureMkdir, writePrivateFileAtomic } from "../../src/state/files.ts";
import { reserveLaunchOwnership } from "../../src/state/launch-ownership.ts";
import { readLoopSidecar, writeLoopDefinitions } from "../../src/state/loop-store.ts";
import { prepareStateDir, sessionDir } from "../../src/state/store.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => vi.useRealTimers());

const NOW = 1_800_000_000_000;
const loop = (id: string, expiresAt: number) => ({
  id,
  message: id,
  mode: "fixed" as const,
  intervalMs: 60_000,
  jitterMs: 0,
  createdAt: expiresAt - LOOP_EXPIRATION_MS,
  expiresAt,
});

describe.runIf(process.platform === "darwin")("launch-owned file boundary", () => {
  test("C-API-61 predecessor persistence cannot write the replacement or forget the wrong original", () => {
    const root = tempDir();
    const directory = join(root, "session");
    const moved = join(root, "moved");
    const replacement = join(root, "replacement");
    mkdirSync(directory);
    mkdirSync(replacement);
    const file = join(directory, "session.json");
    writePrivateFileAtomic(join(replacement, "session.json"), "replacement posture");
    const predecessor = reserveLaunchOwnership(directory);
    predecessor.publishFile(file, "original posture");
    predecessor.commit();
    const resumed = reserveLaunchOwnership(directory);
    resumed.publishFile(file, "attempted posture");
    renameSync(directory, moved);
    renameSync(replacement, directory);
    try {
      expect(predecessor.readFile(file)).toBe("attempted posture");
      predecessor.persistFile(file, "live predecessor update");
      resumed.rollback();
      expect
        .soft(readFileSync(join(moved, "session.json"), "utf8"))
        .toBe("live predecessor update");
      expect(readFileSync(file, "utf8")).toBe("replacement posture");
    } finally {
      predecessor.release();
      resumed.release();
    }
  });

  test.each([
    "initial",
    "commit",
  ])("C-LOOP-13 %s restore cannot copy replacement loops into the original held directory", (phase) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const root = tempDir();
    const state = join(root, "state");
    const replacement = join(root, "replacement");
    const moved = join(root, "moved");
    const id = "resume";
    for (const path of [state, replacement]) {
      prepareStateDir(path, { cwd: root });
      secureMkdir(sessionDir(path, id));
    }
    writeLoopDefinitions(state, id, [
      loop("original-expired", NOW - 1),
      loop("original-live", NOW + 60_000),
    ]);
    writeLoopDefinitions(replacement, id, [
      loop("replacement-expired", NOW - 1),
      loop("replacement-live", NOW + 60_000),
    ]);
    const owner = reserveLaunchOwnership(sessionDir(state, id));
    owner.publishFile(join(sessionDir(state, id), "session.json"), "pending");
    const controller =
      phase === "commit"
        ? new SessionLoops({
            stateDir: state,
            elwoodSessionId: id,
            ownership: owner,
            definitions: [],
            queue: new ControlQueue(
              () => Promise.resolve(),
              () => new Error("closed"),
              () => undefined,
            ),
            emitter: { emit: () => undefined },
          })
        : undefined;
    renameSync(state, moved);
    renameSync(replacement, state);
    try {
      let definitions: readonly { readonly id: string }[];
      if (controller) {
        owner.commit();
        definitions = controller.list();
      } else
        definitions = loadRuntimeLoopDefinitions(
          state,
          id,
          { readFile: owner.readFile, writeFile: owner.publishFile },
          NOW,
        );
      expect.soft(definitions.map(({ id }) => id)).toEqual(["original-live"]);
      expect
        .soft(readLoopSidecar(moved, id).definitions.map(({ id }) => id))
        .toEqual(["original-live"]);
      expect(readLoopSidecar(state, id).definitions.map(({ id }) => id)).toEqual([
        "replacement-expired",
        "replacement-live",
      ]);
    } finally {
      controller?.pause();
      owner.rollback();
      owner.release();
    }
  });
  test("C-API-61 a predecessor forgets only the matching physical parent across pending generations", () => {
    const root = tempDir();
    const directory = join(root, "session");
    const moved = join(root, "moved");
    const replacement = join(root, "replacement");
    mkdirSync(directory);
    mkdirSync(replacement);
    const file = join(directory, "session.json");
    writePrivateFileAtomic(join(replacement, "session.json"), "other posture");
    const predecessor = reserveLaunchOwnership(directory);
    predecessor.publishFile(file, "original posture");
    predecessor.commit();
    const first = reserveLaunchOwnership(directory);
    first.publishFile(file, "first attempt");
    renameSync(directory, moved);
    renameSync(replacement, directory);
    const second = reserveLaunchOwnership(directory);
    second.publishFile(file, "second attempt");
    try {
      predecessor.persistFile(file, "live update");
      second.rollback();
      first.rollback();
      expect(readFileSync(join(moved, "session.json"), "utf8")).toBe("live update");
      expect(readFileSync(file, "utf8")).toBe("other posture");
    } finally {
      predecessor.release();
      first.release();
      second.release();
    }
  });
});
