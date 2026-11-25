/** Verify that Claude retains only the exact live listener through deferred proof (C-ATTN-08). */
import { expect, test, vi } from "vitest";
import { ClaudeWorkspaceTrustEvents } from "../../src/claude/workspace-trust/events.ts";
import type { VerifiedWorkspaceTrust } from "../../src/core/dialogs/workspace-trust-polling.ts";
import type { ClaudeEventMap } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";

const verified: VerifiedWorkspaceTrust<"claude"> = {
  frame: { cols: 80, rows: 24, cursorX: 0, cursorY: 0, lines: [], text: "" },
  request: {
    id: "request",
    elwoodSessionId: "session",
    agent: "claude",
    kind: "trust",
    label: "workspace_trust",
    targetPath: "/workspace",
    targetScope: "folder",
    text: "Trust this folder?",
    choices: [],
  },
};

async function nextTurn() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function openEvents() {
  const emitter = new TypedEmitter<ClaudeEventMap>();
  emitter.on("dialog", () => undefined);
  const readForPublication = vi
    .fn<() => Promise<VerifiedWorkspaceTrust<"claude"> | undefined>>()
    .mockResolvedValue(verified);
  const events = new ClaudeWorkspaceTrustEvents(emitter, {
    evidence: undefined,
    elwoodSessionId: verified.request.elwoodSessionId,
    terminal: () => {
      throw new Error("This test supplies checked native evidence directly.");
    },
    clearance: () => false,
    isLive: () => true,
    humanOwnedPrompt: () => "workspace_trust",
  });
  vi.spyOn(events.discovery, "readForPublication").mockImplementation(readForPublication);
  const isCurrent = vi.spyOn(events.discovery, "isRequestFrameCurrent").mockReturnValue(true);
  vi.spyOn(events.discovery, "reconcile").mockReturnValue({
    frame: verified.frame,
    identity: "captured trust menu",
    menu: {
      target: { targetPath: "/workspace", targetScope: "folder" },
      dialog: { header: "", options: [] },
    },
    revalidateLaunchEvidence: () => Promise.resolve(true),
  });
  events.reconcile();
  await nextTurn();
  return { events, emitter, readForPublication, isCurrent };
}

test("C-ATTN-08 a throwing retained observer can cancel a later exact registration", async () => {
  const { events, emitter } = await openEvents();
  const later = vi.fn();
  const first = vi.fn(() => {
    events.onListenerRemoved(later);
    emitter.off("dialog", later);
    throw new Error("host replay error");
  });
  events.onListenerAdded(first, () => true);
  const isRegistered = emitter.listen("dialog", later);
  if (isRegistered) events.onListenerAdded(later, isRegistered);
  await nextTurn();
  expect(first).toHaveBeenCalledOnce();
  expect(later).not.toHaveBeenCalled();
});

test.each([
  "map",
  "emitter",
])("C-ATTN-08 dropping a retained listener through %s cancels its pending proof", async (source) => {
  const { events, emitter, readForPublication } = await openEvents();
  const began = Promise.withResolvers<void>();
  const release = Promise.withResolvers<VerifiedWorkspaceTrust<"claude">>();
  readForPublication.mockImplementationOnce(() => {
    began.resolve();
    return release.promise;
  });
  const listener = vi.fn();
  const isRegistered = emitter.listen("dialog", listener);
  if (isRegistered) events.onListenerAdded(listener, isRegistered);
  await began.promise;
  if (source === "map") events.onListenerRemoved(listener);
  else emitter.off("dialog", listener);
  release.resolve(verified);
  await nextTurn();
  expect(listener).not.toHaveBeenCalled();
});

test("C-ATTN-08 replay waits when its completed check lost native frame ownership", async () => {
  const { events, isCurrent } = await openEvents();
  const listener = vi.fn();
  isCurrent.mockReturnValueOnce(false);
  events.onListenerAdded(listener, () => true);
  await nextTurn();
  expect(listener).not.toHaveBeenCalled();
  events.reconcile();
  await nextTurn();
  expect(listener).toHaveBeenCalledExactlyOnceWith({ phase: "raised", request: verified.request });
});

test("C-ATTN-08 a canceled replay and its failed proof leave the next registration eligible", async () => {
  const { events, readForPublication } = await openEvents();
  const started = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<VerifiedWorkspaceTrust<"claude">>();
  readForPublication.mockImplementationOnce(() => {
    started.resolve();
    return failed.promise;
  });
  const invalidate = vi.spyOn(events.discovery, "invalidateEvidence");
  const canceled = vi.fn();
  const retained = vi.fn();
  events.onListenerAdded(canceled, () => true);
  events.onListenerAdded(retained, () => true);
  await started.promise;
  events.onListenerRemoved(canceled);
  failed.reject(new Error("Canceled native lookup failed"));
  await nextTurn();
  expect(canceled).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
  expect(retained).toHaveBeenCalledExactlyOnceWith({ phase: "raised", request: verified.request });
});
