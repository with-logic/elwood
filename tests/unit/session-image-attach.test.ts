/**
 * Coverage for enqueueSubmission (PRD §5.3, C-API-44): the no-images fast path,
 * up-front validation rejection before queuing, deferred materialization at
 * dispatch, and temp-file cleanup after attach success/failure.
 */

import { existsSync } from "node:fs";
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

  test("C-API-44 with an empty list takes the fast path", async () => {
    let calls = 0;
    await enqueueSubmission([], noopDriver, () => {
      calls++;
      return Promise.resolve();
    });
    expect(calls).toBe(1);
  });

  test("C-API-44 rejects on an invalid image BEFORE queuing", async () => {
    let queued = false;
    await expect(
      enqueueSubmission([{ data: new Uint8Array(0), format: "png" }], noopDriver, () => {
        queued = true;
        return Promise.resolve();
      }),
    ).rejects.toMatchObject({ code: "invalid_image" });
    expect(queued).toBe(false);
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
    // Force resolveImages to hand back a cleanup that rejects; the attach still
    // succeeds and the cleanup rejection must not surface to the caller.
    vi.resetModules();
    vi.doMock("../../src/core/images/index.ts", async () => {
      const actual = await vi.importActual<typeof import("../../src/core/images/index.ts")>(
        "../../src/core/images/index.ts",
      );
      return {
        ...actual,
        resolveImages: () =>
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
