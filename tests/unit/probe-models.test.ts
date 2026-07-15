/**
 * Unit tests for the shared session-less model-listing probe.
 * Covers PRD §5.3 and C-API-41 teardown/error semantics.
 */

import { describe, expect, test } from "vitest";
import { type ListModelsOptions, probeModels } from "../../src/core/list-models.ts";
import type { AgentModelOption } from "../../src/core/model-rows.ts";

const opts: ListModelsOptions = { cwd: "/tmp/x" };
const rows: readonly AgentModelOption[] = [
  { id: "a", label: "A", isCurrent: true, isDefault: true, raw: "1. A" },
];

type Probe = {
  status: string;
  waitForStatus: (m: (s: string) => boolean) => Promise<unknown>;
  listModels: (o?: { readonly timeoutMs?: number }) => Promise<readonly AgentModelOption[]>;
  teardown: () => Promise<void>;
};

function fakeProbe(over: Partial<Probe> = {}): Probe & {
  teardowns: number;
  timeout: number | undefined;
} {
  const probe = {
    teardowns: 0,
    timeout: undefined as number | undefined,
    status: "ready",
    waitForStatus: () => Promise.resolve("ready"),
    listModels: (o?: { readonly timeoutMs?: number }) => {
      probe.timeout = o?.timeoutMs;
      return Promise.resolve(rows);
    },
    teardown: () => {
      probe.teardowns += 1;
      return Promise.resolve();
    },
    ...over,
  };
  return probe;
}

describe("probeModels", () => {
  test("C-API-41 lists models, forwards the timeout, and tears down exactly once", async () => {
    const probe = fakeProbe();
    const result = await probeModels(() => Promise.resolve(probe), { ...opts, timeoutMs: 1_234 });
    expect(result).toEqual(rows);
    expect(probe.timeout).toBe(1_234);
    expect(probe.teardowns).toBe(1);
  });

  test("C-API-41 omits the timeout when unset, passing undefined to listModels", async () => {
    const probe = fakeProbe();
    await probeModels(() => Promise.resolve(probe), opts);
    expect(probe.timeout).toBeUndefined();
  });

  test("C-API-41 a clean run surfaces a genuine teardown failure", async () => {
    const probe = fakeProbe({ teardown: () => Promise.reject(new Error("teardown failed")) });
    await expect(probeModels(() => Promise.resolve(probe), opts)).rejects.toThrow(
      "teardown failed",
    );
  });

  test("C-API-41 a list failure is surfaced and a failing teardown never masks it", async () => {
    let tornDown = false;
    const probe = fakeProbe({
      listModels: () => Promise.reject(new Error("picker failed")),
      teardown: () => {
        tornDown = true;
        return Promise.reject(new Error("teardown also failed"));
      },
    });
    // The real (picker) error wins; the best-effort teardown failure is swallowed.
    await expect(probeModels(() => Promise.resolve(probe), opts)).rejects.toThrow("picker failed");
    expect(tornDown).toBe(true); // teardown WAS attempted, its failure just swallowed
  });

  test("C-API-41 a start failure surfaces before any session exists (no teardown)", async () => {
    let torn = 0;
    await expect(
      probeModels(() => {
        torn = -1; // sentinel: start rejects, so no probe is ever created
        return Promise.reject(new Error("start failed"));
      }, opts),
    ).rejects.toThrow("start failed");
    expect(torn).toBe(-1);
  });
});
