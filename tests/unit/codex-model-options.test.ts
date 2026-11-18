/** Codex validates native selector IDs before its narrower API returns (C-API-23). */
import { expect, test } from "vitest";
import { codexModelOptions } from "../../src/codex/models/options.ts";

const row = { id: "gpt-5", label: "gpt-5", raw: "gpt-5", isCurrent: true, isDefault: false };

test("C-API-23 Codex preserves the complete native row through its checked boundary", () => {
  expect(codexModelOptions([row])).toEqual([row]);
});

test("C-API-23 Codex rejects an unavailable selector before exposing string IDs", () => {
  expect(() => codexModelOptions([{ ...row, id: null }])).toThrowError(
    expect.objectContaining({ code: "model_automation_failed" }),
  );
});
