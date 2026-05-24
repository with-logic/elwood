# Codex Configuration Notes

Sources researched:

- https://developers.openai.com/codex/config-basic
- https://developers.openai.com/codex/config-advanced
- https://developers.openai.com/codex/config-reference
- https://developers.openai.com/codex/hooks

## Layers

Codex reads configuration from CLI flags and `--config` overrides first, then
profiles, trusted project `.codex/config.toml` files, user config, system config,
and built-in defaults.

Project-local `.codex` layers are only loaded when Codex trusts the project.
Because Elwood should be minimally invasive, it should not edit user or project
Codex config by default.

## Elwood Strategy

Elwood should generate session-scoped hook bridge files under `.elwood/` and
inject Codex hook configuration through `--config` one-off overrides. This keeps
existing `.codex/config.toml` and `~/.codex/config.toml` intact while still
letting Codex merge user defaults and policies normally.

The generated command should enable or configure:

- hooks for every supported Codex hook event;
- the bridge command and timeout for each event;
- optional launch policy such as model, profile, sandbox, approval policy, and
  caller-supplied raw config overrides;
- `--dangerously-bypass-hook-trust` when the installed Codex CLI advertises it,
  because the generated hooks are ephemeral Elwood-owned bridge commands. Elwood
  must omit this flag for Codex versions that do not support it.

If a managed Codex requirement disallows unmanaged hooks, Codex may ignore or
reject Elwood hook config. Elwood should surface startup/bridge failures through
typed errors where possible and hook runtime failures through `hookError`.
