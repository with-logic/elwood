/** Read durable Codex question captures without loading an adapter (PRD §4). */
import { readFileSync } from "node:fs";

export function fixture(name: string): string {
  return readFileSync(
    new URL(`../../fixtures/codex-0.163.0/questions/${name}`, import.meta.url),
    "utf8",
  );
}

export function records(name: string): readonly unknown[] {
  const value: unknown = JSON.parse(fixture(name));
  if (!Array.isArray(value)) throw new Error(`Expected native record array in ${name}`);
  return value;
}
