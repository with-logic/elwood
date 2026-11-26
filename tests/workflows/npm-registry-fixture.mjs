/**
 * Provides the local npm registry for the release publish tests, so they run
 * the real npm client offline against registry documents recorded from
 * registry.npmjs.org (fixtures/elwood-packument.json; the hand-published
 * version's maintainer identity is replaced).
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Returns `env` for npm, configured as actions/setup-node configures it but
 * pointed at the local registry, and `stop()`, which ends the server process.
 */
export async function startRegistry(scratch) {
  const npmrc = join(scratch, "npmrc");
  const script = fileURLToPath(new URL("./npm-registry-server.mjs", import.meta.url));
  // The server writes the npmrc once it knows its port, so a setup failure
  // ends the server itself rather than leaving it running without a stop().
  const server = spawn(process.execPath, [script, npmrc], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  server.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const port = await Promise.race([
    once(server.stdout, "data").then(([chunk]) => String(chunk).trim()),
    once(server, "exit").then(() => undefined),
  ]);
  if (!port) throw new Error(`The local npm registry exited before listening: ${errors.trim()}`);
  const registry = `http://127.0.0.1:${port}/`;
  return {
    env: {
      // Keep npm's trusted-publishing exchange out of runs inside GitHub Actions.
      ACTIONS_ID_TOKEN_REQUEST_URL: "",
      GITHUB_ACTIONS: "",
      NODE_AUTH_TOKEN: "XXXXX-XXXXX-XXXXX-XXXXX",
      npm_config_cache: join(scratch, "npm-cache"),
      npm_config_fetch_retries: "0",
      npm_config_registry: registry,
      npm_config_update_notifier: "false",
      npm_config_userconfig: npmrc,
    },
    stop: () => server.kill(),
  };
}
