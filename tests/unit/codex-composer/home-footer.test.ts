/** Characterized home-directory footer retains positive composer provenance (C-API-56). */
import { expect, test } from "vitest";
import { codexEmptyInputRows } from "../../../src/codex/screen/empty-input.ts";

test.each([
  "  gpt-6.1 low · ~/.coal-harbor/workspaces/example",
  "  gpt-6.1 low · ~/.coal-harbor/…",
  "  gpt-6.1 low · ~/project with spaces",
  "  gpt-6.1 low · ~/project    Plan mode (⇧tab to cycle)",
])("C-API-56 accepts the native home-path footer: %s", (footer) => {
  expect(codexEmptyInputRows(["› Ask Codex to do anything", "", footer], 0)).toBe(true);
});

test.each([
  "  gpt-6.1 low · ~unknown/project",
  "  gpt-6.1 low · ~",
  "  gpt-6.1 low · relative/path",
  "  gpt-6.1 low unexpected trailing prose",
  "  gpt-6.1 low · ~/project\nUnexpected trailing prose",
])("C-API-56 rejects unknown footer grammar and extra prose: %s", (footer) => {
  expect(codexEmptyInputRows(["› Ask Codex to do anything", "", ...footer.split("\n")], 0)).toBe(
    false,
  );
});
