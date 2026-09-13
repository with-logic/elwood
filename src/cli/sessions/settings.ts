/** Agent-free listing settings, preserving path/output precedence (PRD §12A.8, C-CLI-24). */
import { resolveConfigLocation } from "../config/paths.ts";
import { readConfigWithStatus } from "../config/store.ts";
import { resolveStateSetting } from "../request/layers.ts";
import { ioSettings } from "../request/settings.ts";
import { decodeEnvironment, requiredChoice } from "../request/values.ts";
import {
  type CliConfig,
  cliOutputModes,
  type ParsedRunCommand,
  type RequestContext,
} from "../types.ts";

export function resolveListingSettings(
  parsed: ParsedRunCommand,
  context: Omit<RequestContext, "stdin">,
) {
  const path = resolveConfigLocation(context.env, context.invocationCwd, context.homeDir).path;
  const useDefaults = parsed.flags.ignoreDefaults !== true;
  const config: CliConfig = useDefaults ? readConfigWithStatus(path).config : { schemaVersion: 1 };
  // Decode only settings this command consumes; agent defaults cannot invalidate a listing.
  const env = useDefaults
    ? decodeEnvironment({
        ELWOOD_OUTPUT: context.env["ELWOOD_OUTPUT"],
        ELWOOD_STATE_DIR: context.env["ELWOOD_STATE_DIR"],
      })
    : {};
  const output = ioSettings(parsed, env, config, path).output;
  return {
    stateDir: resolveStateSetting(parsed, env, config, path, context).value!,
    output: requiredChoice(output.value!, cliOutputModes, "output"),
    resolution: { sources: { output: output.source } },
  };
}
