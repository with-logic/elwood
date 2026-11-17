/** Bounded, best-effort native model capability evidence. Implements PRD §5.11, C-SPEED-02. */

import { dirname, join } from "node:path";
import type { AgentModelOption } from "../../core/models/rows.ts";
import { isRecord } from "../../core/predicates.ts";
import { type CodexServiceTier, codexServiceTier } from "../../core/speed/types.ts";
import { readBoundedTextFile } from "./read.ts";

/** Cache failures leave capability unknown, without making the model picker unusable. */
export function withCodexServiceTiers(
  options: readonly AgentModelOption[],
  configPath: string,
): readonly AgentModelOption[] {
  try {
    // Reuse the nonblocking regular-file reader and its 1 MiB limit.
    const text = readBoundedTextFile(join(dirname(configPath), "models_cache.json"));
    if (text === undefined) return options;
    const cache = JSON.parse(text) as unknown;
    if (!isRecord(cache)) return options;
    const fetchedAt = cache["fetched_at"];
    if (typeof fetchedAt !== "string" || !Number.isFinite(Date.parse(fetchedAt))) return options;
    const models = cache["models"];
    if (!Array.isArray(models)) return options;
    return options.map((option) => {
      const model: unknown = models.find(
        (value: unknown) => isRecord(value) && value["slug"] === option.id,
      );
      if (!(isRecord(model) && Array.isArray(model["service_tiers"]))) return option;
      const values: ["default", ...CodexServiceTier[]] = ["default"];
      for (const tier of model["service_tiers"]) {
        if (!isRecord(tier) || typeof tier["id"] !== "string" || tier["id"].length === 0)
          return option;
        const value = codexServiceTier(tier["id"]);
        if (value !== undefined && !values.includes(value)) values.push(value);
      }
      return { ...option, codexServiceTiers: { fetchedAt, values } };
    });
  } catch {
    return options;
  }
}
