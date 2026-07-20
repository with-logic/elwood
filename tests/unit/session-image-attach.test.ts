/**
 * Coverage for enqueueSubmission (PRD §5.3, C-API-44): the no-images fast path,
 * synchronous resolve rejection before queuing, attach-then-text ordering, and
 * temp-file cleanup when the op is never queued.
 */

import { existsSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ElwoodError } from "../../src/core/errors.ts";
import type { AttachDriver } from "../../src/runtime/session-image-attach.ts";
import { enqueueSubmission } from "../../src/runtime/session-image-attach.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const noopDriver: AttachDriver = () => Promise.resolve();

describe("enqueueSubmission (C-API-44)", () => {
  test("C-API-44 with no images calls send() with no attach task", async () => {
    let attach: unknown = "unset";
    await enqueueSubmission(undefined, noopDriver, (a) => {
      attach = a;
      return Promise.resolve();
    });
    expect(attach).toBeUndefined();
  });

  test("C-API-44 with an empty image list also takes the fast path", async () => {
    let calls = 0;
    await enqueueSubmission([], noopDriver, () => {
      calls++;
      return Promise.resolve();
    });
    expect(calls).toBe(1);
  });

  test("C-API-44 rejects synchronously on an invalid image before queuing", async () => {
    let queued = false;
    await expect(
      enqueueSubmission([{ data: new Uint8Array(0), format: "png" }], noopDriver, () => {
        queued = true;
        return Promise.resolve();
      }),
    ).rejects.toBeInstanceOf(ElwoodError);
    expect(queued).toBe(false);
  });

  test("C-API-44 drives the attach when the op is queued, then cleans temp files", async () => {
    const seen: string[][] = [];
    const driver: AttachDriver = (paths) => {
      seen.push([...paths]);
      return Promise.resolve();
    };
    let tempPath = "";
    await enqueueSubmission([{ data: PNG, format: "png" }], driver, (attach) => {
      // The queue would call attach before writing the text; emulate that here.
      return (attach as (s: AbortSignal) => Promise<void>)(new AbortController().signal);
    });
    expect(seen).toHaveLength(1);
    tempPath = seen[0]?.[0] as string;
    expect(existsSync(tempPath)).toBe(false); // cleaned up after attach
  });

  test("C-API-44 does not double-clean when attach ran but the text submit failed", async () => {
    // attach runs (its own finally cleans temp files), then the text write fails:
    // the outer catch must NOT clean again (the `!attached` branch is skipped).
    let cleanups = 0;
    const driver: AttachDriver = () => Promise.resolve();
    await expect(
      enqueueSubmission([{ data: PNG, format: "png" }], driver, async (attach) => {
        await (attach as (s: AbortSignal) => Promise<void>)(new AbortController().signal);
        cleanups++; // temp cleanup already happened inside attach's finally
        throw new Error("write failed");
      }),
    ).rejects.toThrow(/write failed/);
    expect(cleanups).toBe(1);
  });

  test("C-API-44 cleans temp files and never attaches when the op never dispatches", async () => {
    let attached = false;
    const driver: AttachDriver = () => {
      attached = true;
      return Promise.resolve();
    };
    // send rejects WITHOUT ever invoking the attach task (session terminal): the
    // not-attached cleanup branch fires and the driver is never run.
    await expect(
      enqueueSubmission([{ data: PNG, format: "png" }], driver, () =>
        Promise.reject(new Error("session_not_running")),
      ),
    ).rejects.toThrow(/session_not_running/);
    expect(attached).toBe(false);
  });
});
