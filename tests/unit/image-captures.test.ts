/** Facade image reservation ownership and real attach transfer (PRD §5.3/§5.8, C-API-44). */
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { capturedImageSnapshot, ImageCaptures } from "../../src/core/images/capture.ts";
import { QueuedImageBudget, sessionImageBudget } from "../../src/core/images/queued-budget.ts";
import type { SendOptions } from "../../src/core/images/types.ts";
import { enqueueSubmission } from "../../src/runtime/session/image-attach.ts";

test("C-API-44 captured images retain one budgeted copy through underlying attachment", async () => {
  const captures = new ImageCaptures(4);
  const data = new Uint8Array([1, 2, 3]);
  const captured = captures.capture({ images: [{ data, format: "png" as const }] });
  data[0] = 9;
  expect(() => captures.capture({ images: [{ data, format: "png" }] })).toThrow(/queued image/);
  const images = captured.options!.images;
  expect(capturedImageSnapshot(images)?.images).toBe(images);
  await enqueueSubmission(
    images,
    async (paths) => {
      expect(await readFile(paths[0]!)).toEqual(Buffer.from([1, 2, 3]));
    },
    async (attach) => attach?.(new AbortController().signal),
    new QueuedImageBudget(0),
  );
  // The facade may replay a submission until turn acceptance; it owns the copy until then.
  expect(capturedImageSnapshot(images)?.images).toBe(images);
  captured.release();
  expect(capturedImageSnapshot(images)).toBeUndefined();
  const next = captures.capture({ images: [{ data, format: "png" }] });
  next.release();
});

test("C-API-44 absent/empty images need no reservation and options are detached", () => {
  const captures = new ImageCaptures(0);
  const absent = captures.capture(undefined);
  expect(absent.options).toBeUndefined();
  absent.release();
  const source: SendOptions & { timeoutMs: number } = { timeoutMs: 20 };
  const plain = captures.capture(source);
  source.timeoutMs = 30;
  expect(plain.options).toEqual({ timeoutMs: 20 });
  plain.release();
  const empty = captures.capture({ images: [] });
  expect(empty.options?.images).toEqual([]);
  empty.release();
});

test("C-API-44 a session keeps one budget of its own until a facade shares the facade's", () => {
  const session = {};
  const own = sessionImageBudget(session);
  expect(sessionImageBudget(session)).toBe(own);
  expect(sessionImageBudget({})).not.toBe(own); // never shared ACROSS sessions
  const captures = new ImageCaptures(3);
  captures.shareWith(session);
  const held = captures.capture({ images: [{ data: new Uint8Array(2), format: "png" }] });
  expect(() => sessionImageBudget(session).reserve(2)).toThrow(/queued image/);
  held.release();
  sessionImageBudget(session).reserve(3);
});
