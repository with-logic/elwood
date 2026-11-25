/** Verify a structured Codex answer independently of the dialog broadcast (C-ATTN-08). */
import { mkdirSync, renameSync, rmdirSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { CodexWorkspaceTrustDiscovery } from "../../src/codex/workspace-trust/discovery.ts";
import { WorkspaceTrustPolling } from "../../src/core/dialogs/workspace-trust-polling.ts";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { resetFakes } from "./helpers.ts";
import { menu, setup } from "./workspace-trust-discovery-fixture.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test.each([
  true,
  false,
])("C-ATTN-08 finishes dialog fan-out before an answer started by its first listener (%s)", async (scopeChanges) => {
  const { cwd, session, pty, render } = await setup();
  const calls: string[] = [];
  const completed = Promise.withResolvers<unknown>();
  const { verifyRequestForAnswer } = CodexWorkspaceTrustDiscovery.prototype;
  vi.spyOn(CodexWorkspaceTrustDiscovery.prototype, "verifyRequestForAnswer").mockImplementation(
    function (this: CodexWorkspaceTrustDiscovery, ...args) {
      calls.push("proof");
      return verifyRequestForAnswer.apply(this, args);
    },
  );
  session.on("dialog", (event) => {
    if (event.phase !== "raised") return;
    calls.push("first");
    void session
      .answerDialog(event.request.id, event.request.choices[0]!.id)
      .then(completed.resolve, completed.resolve);
  });
  session.on("dialog", (event) => {
    if (event.phase !== "raised") return;
    calls.push("second");
    if (scopeChanges) {
      renameSync(cwd, `${cwd}-moved`);
      mkdirSync(cwd);
    }
  });
  try {
    await render(menu(cwd));
    if (scopeChanges) {
      await expect(completed.promise).resolves.toMatchObject({
        code: "dialog_answer_failed",
        details: { category: "frame" },
      });
      expect(pty.writes).toEqual([]);
    } else {
      await expect.poll(() => pty.writes).toEqual(["\r"]);
      await render(codexTty(codexComposer));
      await expect(completed.promise).resolves.toBeUndefined();
    }
    expect(calls).toEqual(["first", "second", "proof"]);
  } finally {
    if (scopeChanges && calls.includes("second")) {
      rmdirSync(cwd);
      renameSync(`${cwd}-moved`, cwd);
    }
    await session.teardown();
  }
});

test("C-ATTN-08 later replay revokes proof verified before the replay callback", async () => {
  const { cwd, session, pty, render } = await setup();
  const first = vi.fn();
  session.on("dialog", first);
  const verified = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await render(menu(cwd));
    await expect.poll(() => first.mock.calls.length).toBe(1);
    const [request] = await session.listDialogs();
    expect(request).toBeDefined();

    const { verifyRequestForAnswer } = CodexWorkspaceTrustDiscovery.prototype;
    vi.spyOn(
      CodexWorkspaceTrustDiscovery.prototype,
      "verifyRequestForAnswer",
    ).mockImplementationOnce(async function (this: CodexWorkspaceTrustDiscovery, ...args) {
      const result = await verifyRequestForAnswer.apply(this, args);
      verified.resolve();
      await release.promise;
      return result;
    });
    const unavailable = expect(
      session.answerDialog(request!.id, request!.choices[0]!.id),
    ).rejects.toMatchObject({ details: { category: "frame" } });
    await verified.promise;
    const late = vi.fn();
    session.on("dialog", late);
    await expect.poll(() => late.mock.calls.length).toBe(1);
    release.resolve();
    await unavailable;
    expect(pty.writes).toEqual([]);
  } finally {
    release.resolve();
    await session.teardown();
  }
});

test.each([
  "aborted",
  "unreadable",
] as const)("C-ATTN-07 an answer whose proof has not started can be %s", async (failure) => {
  const { cwd, session, pty, render } = await setup();
  try {
    await render(menu(cwd));
    const [request] = await session.listDialogs();
    expect(request).toBeDefined();
    const signal = new AbortController();
    if (failure === "unreadable")
      vi.spyOn(CodexWorkspaceTrustDiscovery.prototype, "reconcileCandidate").mockImplementationOnce(
        () => {
          throw new Error("test: optional native frame unreadable");
        },
      );
    const answer = session.answerDialog(request!.id, request!.choices[0]!.id, {
      signal: signal.signal,
    });
    if (failure === "aborted") signal.abort();
    await expect(answer).rejects.toMatchObject({
      details: { category: failure === "aborted" ? "aborted" : "frame" },
    });
    expect(pty.writes).toEqual([]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 a rejected proof retires the previously verified answer request", async () => {
  const { cwd, session, pty, render } = await setup();
  try {
    await render(menu(cwd));
    const [request] = await session.listDialogs();
    expect(request).toBeDefined();
    vi.spyOn(WorkspaceTrustPolling.prototype, "collect").mockImplementationOnce(() =>
      Promise.reject(new Error("test: proof collector rejected")),
    );
    await expect(session.answerDialog(request!.id, request!.choices[0]!.id)).rejects.toMatchObject({
      details: { category: "frame" },
    });
    const [next] = await session.listDialogs();
    expect(next?.id).not.toBe(request!.id);
    expect(pty.writes).toEqual([]);
  } finally {
    await session.teardown();
  }
});
