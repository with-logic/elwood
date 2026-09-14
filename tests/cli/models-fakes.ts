/** Fake process boundaries for combined model CLI tests; use real argument/settings resolution. */
import { executeModels } from "../../src/cli/models/index.ts";
import { resolveRunSettings } from "../../src/cli/request/index.ts";
import { effectiveRequest, mainDependencies, mainHarness } from "./main-fakes.ts";
import { FakeCliSession } from "./run-fakes.ts";

export function modelsHarness(fail?: "claude" | "codex") {
  const h = mainHarness();
  const sessions: FakeCliSession[] = [];
  const agents: string[] = [];
  const dependencies = mainDependencies({
    settings: resolveRunSettings,
    prepare: (request) => {
      agents.push(request.agent);
      if (request.agent === fail) return Promise.reject(new Error("unavailable"));
      const session = new FakeCliSession();
      session.underlying.listModels = () =>
        Promise.resolve([
          {
            id: `${request.agent}-model`,
            label: "Model",
            raw: "row",
            isCurrent: true,
            isDefault: false,
          },
        ]);
      sessions.push(session);
      return Promise.resolve({
        request: effectiveRequest({ agent: request.agent, output: request.output }),
        session,
      });
    },
    listModels: executeModels,
  });
  return { ...h, agents, sessions, dependencies };
}
