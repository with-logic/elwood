/** Keep Claude broadcasts current and revalidate lists that overlap callback delivery (C-ATTN-08). */
import { realpathSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import * as target from "../../src/claude/workspace-trust/target.ts";
import { type ElwoodDialogEvent, type ElwoodDialogRequest, startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { trustFrame } from "./workspace-trust-discovery-fixture.ts";

vi.mock("../../src/claude/workspace-trust/target.ts", { spy: true });
afterEach(() => {
  vi.mocked(target.captureClaudeStartupTrustEvidence).mockReset();
  resetFakes();
});

async function countChecks() {
  const actual = await vi.importActual<typeof target>("../../src/claude/workspace-trust/target.ts");
  const checks = vi.fn();
  vi.mocked(target.captureClaudeStartupTrustEvidence).mockImplementation(async (directory) => {
    const evidence = await actual.captureClaudeStartupTrustEvidence(directory);
    if (!evidence) return undefined;
    return {
      scope: evidence.scope,
      isCurrent: (signal) => {
        checks();
        return evidence.isCurrent(signal);
      },
    };
  });
  return checks;
}

test("C-ATTN-08 a Claude list started by the first listener rechecks after the next callback", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const checks = await countChecks();
  const session = await startClaude({ cwd });
  const list = Promise.withResolvers<readonly ElwoodDialogRequest<"claude">[]>();
  const later = vi.fn();
  session.on("dialog", ({ phase }) => {
    if (phase === "raised") list.resolve(session.listDialogs());
  });
  session.on("dialog", ({ phase }) => {
    if (phase === "raised") later(checks.mock.calls.length);
  });
  try {
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
    expect(await list.promise).toHaveLength(1);
    expect(later).toHaveBeenCalledExactlyOnceWith(2);
    expect(checks).toHaveBeenCalledTimes(3);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 native invalidation in one Claude listener stops a stale raise at the next", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd });
  const later = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  let writing: Promise<void> | undefined;
  session.on("dialog", ({ phase }) => {
    if (phase !== "raised") return;
    writing = session.terminal.writeOutput("host output");
    return writing;
  });
  session.on("dialog", later);
  try {
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
    await expect.poll(() => later.mock.calls.map(([event]) => event.phase)).toEqual(["closed"]);
    await writing;
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 an unchanged announced Claude menu does not need another publication check", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const checks = await countChecks();
  const session = await startClaude({ cwd });
  const events = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  session.on("dialog", events);
  const menu = trustFrame(cwd);
  try {
    ptys[0]!.emitData(menu);
    await session.terminal.settled();
    await expect.poll(() => events.mock.calls.length).toBe(1);
    expect(checks).toHaveBeenCalledOnce();
    ptys[0]!.emitData(menu.replace("❯ No", "  No").replace("   Yes", " ❯ Yes"));
    await session.terminal.settled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(checks).toHaveBeenCalledOnce();
    expect(events).toHaveBeenCalledOnce();
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 Claude reads reflect invalidation by a raised listener", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd });
  const events = vi.fn<(phase: ElwoodDialogEvent<"claude">["phase"]) => void>();
  let writing: Promise<void> | undefined;
  session.on("dialog", (event) => {
    events(event.phase);
    if (event.phase !== "raised") return;
    writing = session.terminal.writeOutput("host output");
    return writing;
  });
  try {
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
    await expect.poll(() => events.mock.calls).toEqual([["raised"], ["closed"]]);
    await writing;
    expect(await session.listDialogs()).toEqual([]);
  } finally {
    await session.teardown();
  }
});
