/** Cached capabilities use the session home and degrade to unknown. C-SPEED-02. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { enrichCodexModels } from "../../src/codex/config/default-model.ts";
import { codexConfigLocksForTests } from "../../src/codex/config/lock.ts";
import { maxTextFileBytes } from "../../src/codex/config/read.ts";
import * as tiers from "../../src/codex/config/service-tiers.ts";
import { tempDir } from "../helpers/tmp.ts";

function cacheFiles() {
  const root = tempDir("speed-catalog-");
  return { config: join(root, "config.toml"), cachePath: join(root, "models_cache.json") };
}
const row = Object.freeze({
  id: "gpt-6.1-sol",
  label: "Sol",
  raw: "Sol",
  isCurrent: true,
  isDefault: false,
});
const fetched_at = "2026-11-16T20:00:00Z";
const cache = (service_tiers: unknown) => ({
  fetched_at,
  models: [null, { slug: row.id, service_tiers }],
});
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));

test("C-SPEED-02 public model-list decorator reads this session's catalog and preserves provenance", async () => {
  const { config, cachePath } = cacheFiles();
  write(
    cachePath,
    cache([{ id: "priority" }, { id: "fast" }, { id: "ultrafast" }, { id: "future" }]),
  );
  const decorate = tiers.withCodexServiceTiers;
  const heldLocks: number[] = [];
  const observation = vi.spyOn(tiers, "withCodexServiceTiers").mockImplementation((...args) => {
    heldLocks.push(codexConfigLocksForTests());
    return decorate(...args);
  });
  try {
    const result = await enrichCodexModels(
      [row, { ...row, id: "unmatched" }],
      new AbortController().signal,
      async () => config,
    );
    expect(result[0]).toMatchObject({
      codexServiceTiers: { fetchedAt: fetched_at, values: ["default", "fast", "ultrafast"] },
    });
    expect(result[1]).not.toHaveProperty("codexServiceTiers");
    expect(heldLocks).toEqual([0]);
  } finally {
    observation.mockRestore();
  }
});

test("C-SPEED-02 explicit empty tiers means only standard is advertised", () => {
  const { config, cachePath } = cacheFiles();
  write(cachePath, cache([]));
  expect(tiers.withCodexServiceTiers([row], config)[0]?.codexServiceTiers?.values).toEqual([
    "default",
  ]);
});

test.each([
  null,
  [],
  {},
  { fetched_at: 5 },
  { fetched_at: "bad", models: [] },
  { fetched_at },
  { fetched_at, models: null },
  cache(null),
  cache([null]),
  cache([{}]),
  cache([{ id: null }]),
  cache([{ id: "" }]),
  cache([[]]),
  { fetched_at, models: [{ slug: row.id, additional_speed_tiers: ["fast"] }] },
])("C-SPEED-02 invalid evidence remains unknown: %j", (value) => {
  const { config, cachePath } = cacheFiles();
  write(cachePath, value);
  const expected = { ...row };
  const result = tiers.withCodexServiceTiers([row], config);
  expect(result).toEqual([expected]);
  expect(result[0]).not.toHaveProperty("codexServiceTiers");
});

test.each([
  ["missing", (_path: string): void => undefined],
  ["malformed", (path: string): void => writeFileSync(path, "{")],
  ["nonregular", (path: string): void => mkdirSync(path)],
  [
    "oversized",
    (path: string): void =>
      writeFileSync(
        path,
        JSON.stringify(cache([{ id: "fast" }])).padEnd(maxTextFileBytes + 1, " "),
      ),
  ],
] as const)("C-SPEED-02 %s cache leaves discovery usable", (_name, prepare) => {
  const { config, cachePath } = cacheFiles();
  prepare(cachePath);
  const expected = { ...row };
  const result = tiers.withCodexServiceTiers([row], config);
  expect(result).toEqual([expected]);
  expect(result[0]).not.toHaveProperty("codexServiceTiers");
});
