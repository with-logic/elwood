/** Cached capabilities use the session home and degrade to unknown. C-SPEED-02. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import { withCodexDefault } from "../../src/codex/config/default-model.ts";
import { maxTextFileBytes } from "../../src/codex/config/read.ts";
import { withCodexServiceTiers } from "../../src/codex/config/service-tiers.ts";

const root = mkdtempSync(join(tmpdir(), "speed-catalog-"));
const config = join(root, "config.toml");
const cachePath = join(root, "models_cache.json");
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
  const expected = { ...row };
  const result = withCodexServiceTiers([row], config);
  expect(result).toEqual([expected]);
  expect(result[0]).not.toHaveProperty("codexServiceTiers");
});

test.each([
  "missing",
  "malformed",
  "nonregular",
  "oversized",
])("C-SPEED-02 %s cache leaves discovery usable", (state) => {
  if (state === "malformed") writeFileSync(cachePath, "{");
  if (state === "nonregular") mkdirSync(cachePath);
  if (state === "oversized") {
    const valid = JSON.stringify(cache([{ id: "fast" }]));
    writeFileSync(cachePath, valid.padEnd(maxTextFileBytes + 1, " "));
  }
  const expected = { ...row };
  const result = withCodexServiceTiers([row], config);
  expect(result).toEqual([expected]);
  expect(result[0]).not.toHaveProperty("codexServiceTiers");
});
