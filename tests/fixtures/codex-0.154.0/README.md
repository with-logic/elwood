# Codex 0.154.0 native startup frames

Captured September 16, 2026 on macOS in a 100-column, 40-row PTY. Temporary
workspace names are replaced with `elwood-native-codex-CAPTURE`.

The private `CODEX_HOME` contained only a copied login, a harmless `true`
SessionStart hook, and the test MCP configuration. No model turn was submitted.
Directory trust was answered with `1` and Enter; hook trust with `2` and Enter.
The path appears before the directory question. The hook footer says
“Press enter to confirm or esc to go back.”

`warning.txt` uses an intentionally failing local `/usr/bin/false` MCP process.
`warning-login.txt` uses a localhost HTTP server returning 401 with a Bearer
challenge. Codex generated the server name and recovery command itself; no
external MCP service was contacted. Codex initially collapses these warnings to
“1 MCP startup issue”; Ctrl+T exposes the canonical diagnostics in its transcript
view.

`tests/e2e/codex-native-startup.e2e.ts` reproduces directory trust, hook trust,
and the login warning through real PTY writes, then checks that both trust gates
have cleared. Its screen-presence checks are independent of the production
recognizer.
