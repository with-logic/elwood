/**
 * The model probe's trust policy: which prompts its implied automatic trust must leave to a
 * human, and why. Implements PRD §5.3, C-CLAUDE-26, and C-CLAUDE-27.
 */

import {
  type ClaudeWorkspaceDisclosure,
  claudeWorkspaceStrongestDisclosure,
} from "../core/trust/copy.ts";
import type { TrustPromptId, TrustPromptIdFor } from "../core/trust/prompts.ts";
import type { TrustView } from "../core/trust/view.ts";

/**
 * Why the model probe refused a prompt (§5.3). A workspace prompt's load row says trusting the
 * folder runs commands, names MCP servers Claude can then start, or applies settings files,
 * which can enable plugins whose hooks run (`*_disclosed`); or the installed Claude is older
 * than the first that discloses hooks (`hooks_undisclosable`); or Claude asks to start one of
 * the folder's MCP servers, plugins, or skills (`*_prompt`); or a painted workspace prompt never
 * verified before its trust budget ran out (`workspace_unverified`).
 */
export type ProbeTrustRefusal =
  | "hooks_disclosed"
  | "hooks_undisclosable"
  | "mcp_servers_disclosed"
  | "settings_disclosed"
  | "mcp_server_prompt"
  | "plugin_prompt"
  | "skill_prompt"
  | "workspace_unverified";

/**
 * What the model probe's trust policy needs (§5.3). Its automatic trust approves only the plain
 * workspace prompt, and only from a Claude that discloses hooks.
 */
export type ProbeTrustOptions = {
  /** Whether the installed Claude can disclose hooks, never whether a prompt disclosed them. */
  readonly canDiscloseHooks: boolean;
  readonly onRefused: (reason: ProbeTrustRefusal) => void;
};

/** The policy as the trust responder applies it: each frame's view, then each state change. */
type ProbeTrustPolicy = {
  /** Leaves a prompt the probe must not answer to a human and reports why. */
  readonly claim: (view: TrustView) => boolean;
  /** Refuses a painted workspace prompt that never verified before its trust budget ran out. */
  readonly onStateChange: (blocked: TrustPromptIdFor<"claude"> | undefined) => void;
};

/**
 * Each other Claude gate's refusal: answering an extension gate would start the folder's code.
 * Every Claude gate is listed, so a new one cannot be answered without a decision here.
 */
const otherGateRefusals: Partial<Record<TrustPromptId, ProbeTrustRefusal | undefined>> = {
  mcp_trust: "mcp_server_prompt",
  plugin_trust: "plugin_prompt",
  skill_trust: "skill_prompt",
  // Accepting the disclaimer runs none of the folder's code, and the probe runs no turn.
  bypass_permissions: undefined,
} satisfies Record<
  Exclude<TrustPromptIdFor<"claude">, "workspace_trust">,
  ProbeTrustRefusal | undefined
>;

/** Each load-row disclosure's refusal; the plain prompt has none. */
const disclosureRefusals: Readonly<Record<ClaudeWorkspaceDisclosure, ProbeTrustRefusal>> = {
  hooks: "hooks_disclosed",
  mcp_servers: "mcp_servers_disclosed",
  settings: "settings_disclosed",
};

/** The probe's trust policy for one launch. A refusal is reported on every frame showing it. */
export function probeTrustPolicy({
  canDiscloseHooks,
  onRefused,
}: ProbeTrustOptions): ProbeTrustPolicy {
  // A launch shows one workspace prompt. A frame read mid-paint is unverified too, so the budget
  // refuses only a prompt that never verified and whose last frame painted its options.
  let workspaceVerified = false;
  let workspaceUnverifiable = false;
  return {
    claim: (view) => {
      if (view.kind !== "candidate") return false;
      if (view.spec.id === "workspace_trust") {
        workspaceVerified ||= view.valid;
        workspaceUnverifiable = !view.valid && view.dialog.options.length > 0;
      }
      const reason = probeTrustRefusal(view, canDiscloseHooks);
      if (reason !== undefined) onRefused(reason);
      return reason !== undefined;
    },
    onStateChange: (blocked) => {
      if (blocked === "workspace_trust" && workspaceUnverifiable && !workspaceVerified)
        onRefused("workspace_unverified");
    },
  };
}

function probeTrustRefusal(
  view: Extract<TrustView, { readonly kind: "candidate" }>,
  canDiscloseHooks: boolean,
): ProbeTrustRefusal | undefined {
  // Refusing writes nothing, so an extension gate is refused from its header alone.
  if (view.spec.id !== "workspace_trust") return otherGateRefusals[view.spec.id];
  // A workspace body may still be painting into the plain prompt, so an unverified one waits
  // for its budget (`onStateChange`).
  if (!view.valid) return undefined;
  if (!canDiscloseHooks) return "hooks_undisclosable";
  const disclosure = claudeWorkspaceStrongestDisclosure(view.dialog.header);
  return disclosure && disclosureRefusals[disclosure];
}
