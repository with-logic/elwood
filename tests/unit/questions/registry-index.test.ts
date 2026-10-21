/** Indexed native identities stay consistent across replacement and retirement (C-QUESTION-05). */
import { expect, test, vi } from "vitest";
import { QuestionRegistry } from "../../../src/core/questions/registry.ts";
import { definitions } from "./helpers.ts";

test("C-QUESTION-05 high-volume identity lookups and unchanged publications do not scan requests", () => {
  const registry = new QuestionRegistry("codex", "indexed", { emit: () => {} });
  const requests = Array.from({ length: 1_000 }, (_, index) =>
    registry.publish(`native-${index}`, "queued", definitions),
  );
  const values = vi.spyOn(Map.prototype, "values");
  try {
    for (const [index, request] of requests.entries()) {
      expect(registry.find(`native-${index}`)).toBe(request);
      expect(registry.publish(`native-${index}`, "queued", definitions)).toBe(request);
    }
    expect(values.mock.calls.length).toBe(0);
  } finally {
    values.mockRestore();
  }
});

test("C-QUESTION-05 source indexes retire with request identity and survive semantic replacement", () => {
  const registry = new QuestionRegistry("codex", "indexed", { emit: () => {} });
  const first = registry.publish("native", "queued", definitions);
  expect(registry.keyFor(first.id)).toBe("native");
  expect(registry.keyFor("unknown")).toBeUndefined();
  const replacement = registry.publish("native", "queued", [definitions[0]!]);
  expect(registry.keyFor(first.id)).toBeUndefined();
  expect(registry.keyFor(replacement.id)).toBe("native");
  expect(registry.find("native")).toBe(replacement);
  registry.clear("unavailable");
  expect(registry.find("native")).toBeUndefined();
  expect(registry.keyFor(replacement.id)).toBeUndefined();
  expect(registry.publish("native", "queued", definitions).id).not.toBe(replacement.id);
});
