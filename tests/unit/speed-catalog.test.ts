/** Cached capabilities use the session home and degrade to unknown. C-SPEED-02. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import { withCodexDefault } from "../../src/codex/config/default-model.ts";
import { maxCodexConfigBytes } from "../../src/codex/config/read.ts";
import { withCodexServiceTiers } from "../../src/codex/config/service-tiers.ts";

const root = mkdtempSync(join(tmpdir(), "speed-catalog-"));
const config = join(root, "config.toml");
const cachePath = join(root, "models_cache.json");
const row = { id: "gpt-6.1-sol", label: "Sol", raw: "Sol", isCurrent: true, isDefault: false };
const fetched_at = "2026-11-16T20:00:00Z";
const cache = (service_tiers: unknown) => ({
  fetched_at,
  models: [null, { slug: row.id, service_tiers }],
});
const write = (value: unknown) => writeFileSync(cachePath, JSON.stringify(value));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => rmSync(cachePath, { recursive: true, force: true }));

test("C-SPEED-02 public model-list decorator reads this session's catalog and preserves provenance", async () => {
  write(cache([{ id: "priority" }, { id: "fast" }, { id: "ultrafast" }, { id: "future" }]));
  const result = await withCodexDefault(
    [row, { ...row, id: "unmatched" }],
    new AbortController().signal,
    async () => config,
  );
  expect(result[0]).toMatchObject({
    codexServiceTiers: { fetchedAt: fetched_at, values: ["default", "fast", "ultrafast"] },
  });
  expect(result[1]).not.toHaveProperty("codexServiceTiers");
});

test("C-SPEED-02 explicit empty tiers means only standard is advertised", () => {
  write(cache([]));
  expect(withCodexServiceTiers([row], config)[0]?.codexServiceTiers?.values).toEqual(["default"]);
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
  write(value);
  expect(withCodexServiceTiers([row], config)).toEqual([row]);
});

test("C-SPEED-02 missing, malformed, nonregular and oversized cache leaves discovery usable", () => {
  expect(withCodexServiceTiers([row], config)).toEqual([row]);
  writeFileSync(cachePath, "{");
  expect(withCodexServiceTiers([row], config)).toEqual([row]);
  rmSync(cachePath);
  mkdirSync(cachePath);
  expect(withCodexServiceTiers([row], config)).toEqual([row]);
  rmSync(cachePath, { recursive: true });
  writeFileSync(cachePath, " ".repeat(maxCodexConfigBytes + 1));
  expect(withCodexServiceTiers([row], config)).toEqual([row]);
});
