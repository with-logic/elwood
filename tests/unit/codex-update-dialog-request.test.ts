/**
 * Reads Codex's update offer as a `kind: "update"` request, and keeps that kind out of
 * Claude's request type (PRD §5.13 "Codex update offers", C-ATTN-12).
 */

import { expect, expectTypeOf, test } from "vitest";
import {
  createCodexUpdateDialogRequest,
  readCodexUpdateOffer,
} from "../../src/codex/update/dialog-request.ts";
import type {
  ElwoodDialogRequest,
  ElwoodTrustDialogRequest,
  ElwoodUpdateDialogRequest,
} from "../../src/index.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

const choices = "› 1. Update now\n  2. Skip";

test("C-ATTN-12 the 0.155 offer gives its versions, banner text and choices", () => {
  expect(readCodexUpdateOffer(capturedFrame("codex-0.155.1/update-100x30"))).toEqual({
    text: "✨ Update available! 0.155.1 -> 0.156.1 Release notes: https://github.com/openai/codex/releases/latest",
    versions: { installed: "0.155.1", offered: "0.156.1" },
    labels: [
      "Update now (runs `sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'`)",
      "Skip",
      "Skip until next version",
    ],
  });
});

test("C-ATTN-12 a 40-column offer folds its wrapped link into the text", () => {
  const offer = readCodexUpdateOffer(capturedFrame("codex-0.172.0/update/offer-standalone-40x30"));
  expect(offer?.text).toMatch(
    /^Update available · 0\.172\.0 → 99\.0\.0 Release notes: https:\S+ \S+$/,
  );
  expect(offer?.labels.slice(1)).toEqual(["Skip", "Skip until next version"]);
});

test("C-ATTN-12 a banner without versions gives no versions", () => {
  expect(readCodexUpdateOffer(`A new version of Codex is available.\n${choices}`)).toEqual({
    text: "A new version of Codex is available.",
    labels: ["Update now", "Skip"],
  });
});

test("C-ATTN-12 a request from a banner without versions has no versions field", () => {
  const offer = readCodexUpdateOffer(`A new version of Codex is available.\n${choices}`);
  const request = createCodexUpdateDialogRequest("session-1", offer!);
  expect(request).toEqual({
    id: expect.any(String),
    elwoodSessionId: "session-1",
    agent: "codex",
    kind: "update",
    label: "codex_update",
    text: "A new version of Codex is available.",
    choices: [
      { id: expect.any(String), label: "Update now" },
      { id: expect.any(String), label: "Skip" },
    ],
  });
  expect("versions" in request).toBe(false);
  expect(new Set([request.id, ...request.choices.map((choice) => choice.id)]).size).toBe(3);
});

test.each([
  ["a banner without choices", "Update available · 0.172.0 → 99.0.0"],
  ["choices without a banner", choices],
  ["an unknown choice", `Update available · 0.172.0 → 99.0.0\n${choices}\n  3. Uninstall`],
])("C-ATTN-12 %s is not an offer", (_, frame) => {
  expect(readCodexUpdateOffer(frame)).toBeUndefined();
});

test("C-ATTN-12 Claude's request type has no update kind", () => {
  expectTypeOf<ElwoodDialogRequest<"claude">>().toEqualTypeOf<ElwoodTrustDialogRequest<"claude">>();
  expectTypeOf<ElwoodDialogRequest>().toEqualTypeOf<
    ElwoodTrustDialogRequest | ElwoodUpdateDialogRequest
  >();
  expectTypeOf<
    Extract<ElwoodDialogRequest<"claude" | "codex">, { kind: "update" }>
  >().toEqualTypeOf<ElwoodUpdateDialogRequest>();
});
