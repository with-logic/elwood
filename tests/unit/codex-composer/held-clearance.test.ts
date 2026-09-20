/** Native composer provenance keeps trust-owned input held (C-TRUST-01). */
import { afterEach, expect, test, vi } from "vitest";
import { codexTrustClearance } from "../../../src/codex/screen-table.ts";
import { TrustPromptResponder } from "../../../src/core/trust/responder.ts";
import { codexComposer } from "../../fixtures/trust-composer.ts";

afterEach(() => vi.useRealTimers());

test.each([
  codexComposer.replace("› Ask", "• Working (3s • esc to interrupt)\n› Ask"),
  "• A quoted example:\n  › Implement {feature}\n  gpt-5.5 high",
])("C-TRUST-01 a held generation survives active work and quoted chrome: %s", (frame) => {
  vi.useFakeTimers();
  const responder = new TrustPromptResponder("codex", codexTrustClearance, true);
  const write = vi.fn();
  try {
    responder.handle("Do you trust the contents of this directory?", write);
    expect(responder.inputBlocking).toBe(true);
    responder.handle(frame, write);
    expect(responder.inputBlocking).toBe(true);
    expect(write).not.toHaveBeenCalled();
    responder.handle(codexComposer, write);
    expect(responder.inputBlocking).toBe(false);
    expect(write).not.toHaveBeenCalled();
  } finally {
    responder.dispose();
  }
});
