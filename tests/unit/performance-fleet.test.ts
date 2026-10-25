/** Fleet probes verify owned cleanup and per-session accounting (PRD §9.4). */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { additionalResources } from "../../scripts/performance/fleet/resources.ts";
import { createFleet } from "../../scripts/performance/fleet/runtime.ts";
import { exerciseFleet } from "../../scripts/performance/fleet/workload.ts";
import { setPlatformForTests } from "../../src/runtime/seams.ts";
import { resetProcessTreeOpsForTests } from "../../src/runtime/shutdown/reap-tree.ts";
import { resetStartupWaitMsForTests } from "../../src/runtime/startup/index.ts";
import { sessionSocketHome } from "../../src/state/socket-home.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetProcessTreeOpsForTests();
  resetStartupWaitMsForTests();
});

test("C-LIFE-10 fleet resources count extra handles of a baseline type", () => {
  expect(additionalResources(["PipeWrap"], ["PipeWrap", "PipeWrap", "Timeout"])).toEqual([
    "PipeWrap",
    "Timeout",
  ]);
  expect(additionalResources(["PipeWrap", "Timeout"], ["PipeWrap"])).toEqual([]);
});

test("C-LIFE-10 synthetic fleet cleans up both adapters on a non-macOS host", async () => {
  setPlatformForTests("linux");
  const fleet = await createFleet(2);
  const homes = fleet.sessions.map((session, index) =>
    sessionSocketHome({
      stateDir: join(fleet.root, "state"),
      elwoodSessionId: session.elwoodSessionId,
      adapter: index === 0 ? "claude" : "codex",
    }),
  );
  try {
    expect(homes.every(existsSync)).toBe(true);
    await fleet.dispose();
    expect(homes.some(existsSync)).toBe(false);
    expect(existsSync(fleet.root)).toBe(false);
  } finally {
    await fleet.dispose();
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
});

test("C-LIFE-10 rejected teardown waits for sibling shutdown before removing shared files", async () => {
  const fleet = await createFleet(2);
  const first = fleet.sessions[0]!;
  const second = fleet.sessions[1]!;
  const firstTeardown = first.teardown.bind(first);
  const secondTeardown = second.teardown.bind(second);
  const gate = Promise.withResolvers<void>();
  const firstDone = Promise.withResolvers<void>();
  vi.spyOn(first, "teardown").mockImplementation(async () => {
    await firstTeardown();
    firstDone.resolve();
    throw new Error("first failure");
  });
  vi.spyOn(second, "teardown").mockImplementation(async () => {
    await gate.promise;
    await secondTeardown();
  });
  const cleanup = fleet.dispose();
  const rejected = expect(cleanup).rejects.toThrow("Fleet teardown failed.");
  const completed = vi.fn();
  void cleanup.then(completed, completed);
  try {
    await firstDone.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completed).not.toHaveBeenCalled();
    expect(existsSync(fleet.root)).toBe(true);
  } finally {
    gate.resolve();
    await rejected;
  }
  expect(existsSync(fleet.root)).toBe(false);
});

test("C-API-15 fleet workload rejects terminal event attribution to the wrong session", async () => {
  const fleet = await createFleet(2);
  const first = fleet.sessions[0]!;
  const subscribe = first.on.bind(first);
  vi.spyOn(first, "on").mockImplementation((event, handler) =>
    subscribe(event, (payload) => handler({ ...payload, elwoodSessionId: "wrong-session" })),
  );
  try {
    await expect(exerciseFleet(fleet, 2)).rejects.toThrow(
      `Transcript count mismatch for ${first.elwoodSessionId}`,
    );
  } finally {
    await fleet.dispose();
  }
});

test.each([
  "bytes",
  "transcripts",
])("C-API-15 fleet totals cannot hide offsetting per-session %s gaps", async (metric) => {
  const fleet = await createFleet(2);
  for (const [index, session] of fleet.sessions.entries()) {
    const subscribe = session.on.bind(session);
    vi.spyOn(session, "on").mockImplementation((event, handler) =>
      subscribe(event, (payload) => {
        if (metric === "bytes" && "data" in payload && typeof payload.data === "string")
          handler({ ...payload, data: index === 0 ? `${payload.data}x` : payload.data.slice(1) });
        else if (
          metric === "transcripts" &&
          "source" in payload &&
          payload.source === "transcript"
        ) {
          if (index === 0) {
            handler(payload);
            handler(payload);
          }
        } else handler(payload);
      }),
    );
  }
  try {
    await expect(exerciseFleet(fleet, 2)).rejects.toThrow(
      metric === "bytes" ? "Terminal byte count mismatch" : "Transcript count mismatch",
    );
  } finally {
    await fleet.dispose();
  }
});
