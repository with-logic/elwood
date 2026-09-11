# Security Policy

Elwood drives interactive agent CLIs (Claude Code and Codex) inside real
terminal sessions, answers a narrow allowlist of their trust prompts on behalf
of the embedding application, and can drive Claude's `/login` recovery flow.
Bugs in those paths can change the security posture of the wrapped agent, so we
treat them as security issues.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting for this repository ("Report a vulnerability"
under the Security tab). Include the Elwood version, the agent CLI and version,
the operating system, and a minimal reproduction.

We aim to acknowledge reports within five business days.

## Scope

In scope:

- Elwood answering a prompt it should not have answered, or submitting input
  into a dialog it should have treated as blocking.
- Leakage of bridge tokens, hook payloads, terminal contents, or other secrets
  into persisted state, warnings, structured CLI output, or logs.
- Escapes from the session-scoped settings and configuration Elwood generates
  (for example, mutating a user's global agent configuration when the
  documentation says it will not).
- Unsafe filesystem handling in Elwood-owned state: symlink following,
  permission checks, or non-atomic writes.
- Command construction that could execute attacker-controlled input.

Out of scope:

- Behavior of the wrapped agents themselves. Report those to Anthropic or
  OpenAI.
- Actions an agent takes inside a workspace you asked it to work in with the
  permissions you granted it.

## Supported versions

Only the latest release receives security fixes.
