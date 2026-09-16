#!/usr/bin/env bash
# Installs pinned reviewer tools without executing project dependency scripts.
set -euo pipefail
prefix="$REVIEW_TOOLS"
npm install --global --prefix "$prefix" --registry=https://registry.npmjs.org \
  --userconfig=/dev/null --allow-scripts=opencode-ai opencode-ai@1.18.16
# The CLI wrapper can exist without its downloaded executable.
test -x "$prefix/lib/node_modules/opencode-ai/bin/opencode.exe"
# Install before fan-out; OpenCode's concurrent first-run downloads race.
name=ripgrep-14.1.1-x86_64-unknown-linux-musl
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 --retry-all-errors --max-time 120 --max-filesize 20000000 \
  "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/$name.tar.gz" -o "$tmp/rg.tar.gz"
echo "4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e  $tmp/rg.tar.gz" | sha256sum -c -
tar -xzf "$tmp/rg.tar.gz" --strip-components=1 -C "$tmp"
mkdir -p "$prefix/bin"
install -m 0755 "$tmp/rg" "$prefix/bin/rg"
