/** Indexed native identities stay consistent across replacement and retirement (PRD §4). */
import { expect, test, vi } from "vitest";
import { QuestionRegistry } from "../../../src/core/questions/registry.ts";
import type { ElwoodQuestionRequest } from "../../../src/core/questions/types.ts";
import { definitions } from "./helpers.ts";

test("high-volume identity lookups and unchanged publications do not scan requests", () => {
  const registry = new QuestionRegistry("codex", "indexed", { emit: () => {} });
  const requests = Array.from({ length: 1_000 }, (_, index) =>
    registry.publish(`native-${index}`, "queued", definitions),
  );
  const scans = [
    vi.spyOn(Map.prototype, "values"),
    vi.spyOn(Map.prototype, "entries"),
    vi.spyOn(Map.prototype, Symbol.iterator),
    vi.spyOn(Map.prototype, "forEach"),
  ];
  const found: (ElwoodQuestionRequest | undefined)[] = [];
  const published: (ElwoodQuestionRequest | undefined)[] = [];
  let pending = false;
  let calls: readonly number[] = [];
  for (const scan of scans) scan.mockClear();
  try {
    for (const [index] of requests.entries()) {
      found.push(registry.find(`native-${index}`));
      published.push(registry.publish(`native-${index}`, "queued", definitions));
    }
    pending = registry.hasPending();
    calls = scans.map((scan) => scan.mock.calls.length);
  } finally {
    for (const scan of scans) scan.mockRestore();
  }
  for (const [index, request] of requests.entries()) {
    expect(found[index]).toBe(request);
    expect(published[index]).toBe(request);
  }
  expect(pending).toBe(true);
  expect(calls).toEqual([0, 0, 0, 0]);
});

test("source indexes retire with request identity and survive semantic replacement", () => {
  const registry = new QuestionRegistry("codex", "indexed", { emit: () => {} });
  const first = registry.publish("native", "queued", definitions)!;
  expect(registry.keyFor(first.id)).toBe("native");
  expect(registry.keyFor("unknown")).toBeUndefined();
  const replacement = registry.publish("native", "queued", [definitions[0]!])!;
  expect(registry.keyFor(first.id)).toBeUndefined();
  expect(registry.keyFor(replacement.id)).toBe("native");
  expect(registry.find("native")).toBe(replacement);
  registry.clear("unavailable");
  expect(registry.find("native")).toBeUndefined();
  expect(registry.keyFor(replacement.id)).toBeUndefined();
  expect(registry.publish("native", "queued", definitions)!.id).not.toBe(replacement.id);
});
