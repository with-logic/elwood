/**
 * The status engine splits durable persistence from event delivery so a turn-start
 * transition commits in-memory `current` between them: a persist failure aborts
 * before commit (no wedge), and a throwing status listener runs only after durable
 * and in-memory status already agree (no split). Covers PRD §5.3 and C-API-42.
 */

import { describe, expect, test } from "vitest";
import { SessionStatusEngine, type StatusEngineIo } from "../../src/runtime/status-evidence.ts";

const quietQueue = {
  queueRunning: () => undefined,
  queueReady: () => undefined,
  queueBlocked: () => undefined,
  queueClose: () => undefined,
  cleanup: () => undefined,
};

describe("SessionStatusEngine persist/emit split (C-API-42)", () => {
  test("C-API-42 a throwing status listener never splits committed status from persistence", () => {
    // A `running`-transition status listener that throws must run only AFTER both the
    // durable write and in-memory `current` are committed, so the two can never
    // diverge (persisted `running` while `current` stays `ready`). The throw still
    // propagates so the initial-ready fallback can classify it (C-API-42).
    const persisted: string[] = [];
    const io: StatusEngineIo = {
      persistStatus: (status) => persisted.push(status),
      emitStatus: () => {
        throw new Error("rogue status listener");
      },
      ...quietQueue,
    };
    const engine = new SessionStatusEngine(io);
    expect(() => engine.submit("startup_usable")).toThrow(/rogue status listener/);
    // In-memory status matches what was persisted — no split.
    expect(engine.status).toBe("running");
    expect(persisted).toEqual(["running"]);
  });

  test("C-API-42 a persist failure on turn start aborts BEFORE committing status", () => {
    // If the durable write fails, `current` must NOT advance to `running` (else the
    // session wedges as running with a stale record); the failure propagates so the
    // queue rolls back and no text is submitted.
    const io: StatusEngineIo = {
      persistStatus: () => {
        throw new Error("disk full");
      },
      emitStatus: () => undefined,
      ...quietQueue,
    };
    const engine = new SessionStatusEngine(io);
    expect(() => engine.submit("startup_usable")).toThrow(/disk full/);
    expect(engine.status).toBe("starting"); // never committed running
  });
});
