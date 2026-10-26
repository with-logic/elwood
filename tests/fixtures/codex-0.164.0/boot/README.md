# Codex 0.164.0 boot and configured composers

Captured on 2026-10-25 from installed Codex 0.164.0, launched by Elwood's `startCodex`
(`autotrust: false`) in a fresh `git init` folder with an isolated `CODEX_HOME`, rendered
through Elwood's headless terminal. Eight launches ran at once (load average about 40).
The project path was replaced with `/tmp/elwood-boot-CAPTURE/project` and trailing
spaces were removed.

- `boot-composer.txt` is the first frame showing a composer. Codex painted it about
  0.6 s after its first output, before its directory-trust gate. The header still reads
  `loading`, and no model footer sits under the composer.
- `configured-composer.txt` is the first composer frame with the model footer
  (`GPT-6.1-Sol default · <path>`), painted once the gate was answered.

In all eight launches the boot composer came first and had no model footer. The four
git-folder launches showed their gate 3.4 to 3.9 s after their first output, and the
model footer appeared only after the gate cleared.
