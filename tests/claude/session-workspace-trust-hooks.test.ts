/**
 * Claude's workspace prompt that discloses a folder's hooks (captured from 2.1.332) is listed
 * with `disclosesHooks` and answered like the plain prompt; altered hooks rows are not
 * listed (PRD §5.4, §5.13, C-CLAUDE-26).
 */
import { expect, test, vi } from "vitest";
import { tty } from "../fixtures/trust-composer.ts";
import {
  claudeWorkspaceTrustScreen,
  claudeHooksSettingsLoad as load,
  claudeHooksWarning as warning,
} from "../helpers/claude-workspace-trust-screen.ts";
import { ready } from "./login-helpers.ts";
import { composer, selectYes, setupClaudeAnswer } from "./workspace-trust-answer-fixture.ts";

const folded = `Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first. Claude Code'll be able to read, edit, and execute files here. ${warning} ${load} Security guide`;

test("C-CLAUDE-26 Claude lists the hooks prompt as declaring hooks and answers it", async () => {
  const { cwd, session, pty, render, request, settle } = await setupClaudeAnswer();
  const menu = (selected: "yes" | "no") => tty(claudeWorkspaceTrustScreen(cwd, selected, "hooks"));
  await render(menu("no"));
  const opened = await request();
  expect(opened).toEqual({
    id: expect.any(String),
    elwoodSessionId: session.elwoodSessionId,
    agent: "claude",
    kind: "trust",
    label: "workspace_trust",
    targetPath: cwd,
    targetScope: "folder",
    disclosesHooks: true,
    text: folded,
    choices: [
      { id: expect.any(String), label: "No, exit" },
      { id: expect.any(String), label: "Yes, I trust this folder" },
    ],
  });
  await ready(cwd, session);
  await settle();
  const done = session.answerDialog(opened.id, opened.choices[1]!.id);
  void done.catch(() => undefined);
  await vi.waitFor(() => expect(pty.writes).toEqual([selectYes]));
  await render(menu("yes"));
  await vi.waitFor(() => expect(pty.writes).toEqual([selectYes, `${selectYes}\r`]));
  await render(composer);
  await done;
  expect(await session.listDialogs()).toEqual([]);
});

test("C-CLAUDE-26 a hooks prompt with an unknown row is not listed", async () => {
  const { cwd, session, render } = await setupClaudeAnswer();
  const altered = claudeWorkspaceTrustScreen(cwd, "no", "hooks").replace(
    load,
    `${load}\n Hooks also run on every prompt.`,
  );
  await render(tty(altered));
  expect(await session.listDialogs()).toEqual([]);
  await render(tty(claudeWorkspaceTrustScreen(cwd, "no", "hooks")));
  expect(await session.listDialogs()).toEqual([expect.objectContaining({ disclosesHooks: true })]);
});
