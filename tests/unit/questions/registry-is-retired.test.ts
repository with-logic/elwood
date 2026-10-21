/** Registry entry state is the sole authority for native retirement (PRD §4). */
import { expect, test } from "vitest";
import { definitions, registry } from "./helpers.ts";

test("only an existing retired native reservation reports retirement", () => {
  const requests = registry();
  expect(requests.isRetired("native")).toBe(false);
  const request = requests.publish("native", "blocking", definitions)!;
  expect(requests.isRetired("native")).toBe(false);
  requests.retireUnconfirmed(request.id);
  expect(requests.isRetired("native")).toBe(true);
  requests.close(request.id, "answered");
  expect(requests.isRetired("native")).toBe(false);
});
