/**
 * Coverage for enqueueSubmission (PRD §5.3, C-API-44): the no-images fast path, a
 * synchronous byte snapshot at the public boundary (so a later caller mutation is
 * inert and an invalid input rejects before it is queued), synchronous FIFO
 * enqueue, path-resolution + materialization at dispatch, and temp-file cleanup
 * after attach success/failure.
 */

import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AttachDriver } from "../../src/runtime/session-image-attach.ts";
import { enqueueSubmission } from "../../src/runtime/session-image-attach.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const noopDriver: AttachDriver = () => Promise.resolve();
const runAttach = (attach?: (s: AbortSignal) => Promise<void>) =>
  attach ? attach(new AbortController().signal) : Promise.resolve();

describe("enqueueSubmission (C-API-44)", () => {
  test("C-API-44 with no images calls send() with no attach task", async () => {
    let attach: unknown = "unset";
    await enqueueSubmission(undefined, noopDriver, (a) => {
      attach = a;
      return Promise.resolve();
    });
    expect(attach).toBeUndefined();
  });

  test("C-API-44 with an empty ARRAY takes the fast path", async () => {
    let calls = 0;
    await enqueueSubmission([], noopDriver, () => {
      calls++;
      return Promise.resolve();
    });
    expect(calls).toBe(1);
  });

  test("C-API-44 a non-array empty-ish value REJECTS, never a silent no-image send", async () => {
    // An untyped caller passing "" or { length: 0 } must not slip past validation via
    // the old `length === 0` fast path — both are non-arrays and reject invalid_image.
    for (const bad of ["", { length: 0 }] as const) {
      let sent = false;
      await expect(
        enqueueSubmission(bad as never, noopDriver, () => {
          sent = true;
          return Promise.resolve();
        }),
      ).rejects.toMatchObject({ code: "invalid_image" });
      expect(sent).toBe(false); // never sent as a no-image submission
    }
  });

  test("C-API-44 an invalid image rejects SYNCHRONOUSLY, before it is ever queued", async () => {
    let queued = false;
    // The byte snapshot runs at the public boundary (before enqueue), so a
    // malformed input (empty bytes) rejects without ever occupying a queue slot —
    // it cannot wedge the queue and the send closure is never invoked.
    await expect(
      enqueueSubmission([{ data: new Uint8Array(0), format: "png" }], noopDriver, (attach) => {
        queued = true;
        return runAttach(attach);
      }),
    ).rejects.toMatchObject({ code: "invalid_image" });
    expect(queued).toBe(false);
  });

  test("C-API-44 byte buffers are cloned at the call, so a later caller mutation is inert", async () => {
    const bytes = Uint8Array.from(PNG);
    let attachedContent: Buffer | undefined;
    const driver: AttachDriver = (paths) => {
      attachedContent = readFileSync(paths[0] as string); // the materialized temp file
      return Promise.resolve();
    };
    // The snapshot (byte clone) runs synchronously inside enqueueSubmission, so a
    // mutation right after the call cannot reach the temp file the attach reads.
    const done = enqueueSubmission([{ data: bytes, format: "png" }], driver, runAttach);
    bytes[0] = 0; // mutate the caller's buffer AFTER the synchronous snapshot
    await done;
    expect(attachedContent).toEqual(Buffer.from(PNG)); // attached the ORIGINAL bytes
    expect(bytes[0]).toBe(0); // the caller's own buffer did change — the clone did not
  });

  test("C-API-44 an image submission does not await validation before enqueuing", async () => {
    // The send() closure runs synchronously in call order (no pre-queue await), so
    // a later plain submission cannot overtake an image submission.
    const order: string[] = [];
    const image = enqueueSubmission([{ data: PNG, format: "png" }], noopDriver, () => {
      order.push("image");
      return Promise.resolve();
    });
    const plain = enqueueSubmission(undefined, noopDriver, () => {
      order.push("plain");
      return Promise.resolve();
    });
    await Promise.all([image, plain]);
    expect(order).toEqual(["image", "plain"]);
  });

  test("C-API-44 materializes at dispatch, drives the attach, then cleans temp files", async () => {
    const seen: string[][] = [];
    const driver: AttachDriver = (paths) => {
      seen.push([...paths]);
      return Promise.resolve();
    };
    await enqueueSubmission([{ data: PNG, format: "png" }], driver, runAttach);
    expect(seen).toHaveLength(1);
    expect(existsSync(seen[0]?.[0] as string)).toBe(false); // cleaned after attach
  });

  test("C-API-44 cleans temp files when the attach driver fails", async () => {
    const seen: string[] = [];
    const driver: AttachDriver = (paths) => {
      seen.push(paths[0] as string);
      return Promise.reject(new Error("attach boom"));
    };
    await expect(
      enqueueSubmission([{ data: PNG, format: "png" }], driver, runAttach),
    ).rejects.toThrow(/attach boom/);
    expect(existsSync(seen[0] as string)).toBe(false);
  });

  test("C-API-44 never materializes when the op is never dispatched", async () => {
    let attached = false;
    const driver: AttachDriver = () => {
      attached = true;
      return Promise.resolve();
    };
    // send rejects WITHOUT invoking the attach task (session terminal): nothing
    // is materialized (deferred to dispatch) and the driver never runs.
    await expect(
      enqueueSubmission([{ data: PNG, format: "png" }], driver, () =>
        Promise.reject(new Error("session_not_running")),
      ),
    ).rejects.toThrow(/session_not_running/);
    expect(attached).toBe(false);
  });

  test("C-API-44 a cleanup failure after a successful attach is swallowed", async () => {
    // Force materializeImages to hand back a cleanup that rejects; the attach still
    // succeeds and the cleanup rejection must not surface to the caller.
    vi.resetModules();
    vi.doMock("../../src/core/images/index.ts", async () => {
      const actual = await vi.importActual<typeof import("../../src/core/images/index.ts")>(
        "../../src/core/images/index.ts",
      );
      return {
        ...actual,
        materializeImages: () =>
          Promise.resolve({ paths: ["/x.png"], cleanup: () => Promise.reject(new Error("rm")) }),
      };
    });
    const { enqueueSubmission: mocked } = await import("../../src/runtime/session-image-attach.ts");
    await expect(
      mocked([{ data: PNG, format: "png" }], () => Promise.resolve(), runAttach),
    ).resolves.toBeUndefined();
    vi.doUnmock("../../src/core/images/index.ts");
    vi.resetModules();
  });
});

afterEach(() => vi.resetModules());
