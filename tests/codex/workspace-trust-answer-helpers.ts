/** Native workspace menu and PTY setup for structured answer tests (C-ATTN-07). */
import {
  interceptWorkspaceLookup,
  menu,
  proofPause,
  setup,
} from "./workspace-trust-discovery-fixture.ts";

export { menu };

export async function setupWorkspaceAnswer() {
  const { cwd, session, pty, render } = await setup();
  await render(menu(cwd));
  const [request] = await session.listDialogs();
  if (!request) {
    await session.teardown();
    throw new Error("Expected a verified workspace trust request");
  }
  return { cwd, session, pty, render, request };
}

export async function holdWorkspaceProof(cwd: string) {
  const pause = proofPause();
  const resumed = Promise.withResolvers<void>();
  await interceptWorkspaceLookup(cwd, () => pause.wait().then(resumed.resolve));
  return { began: pause.began, resumed: resumed.promise, release: pause.release };
}
