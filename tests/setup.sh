#!/usr/bin/env bash
# Link the runtime deps the ATP extension imports so `node --test` can resolve
# bare specifiers from the repo tree (the extension file lives under agent/,
# so resolution walks up from agent/extensions/... to the repo root).
#
# Dev-only: tests are never installed into ~/.pi by install.sh.
# Idempotent; override the pi package location with PI_PKG=<path>.
set -euo pipefail
cd "$(dirname "$0")/.."

PI_PKG="${PI_PKG:-$HOME/.pi/node/lib/node_modules/@earendil-works/pi-coding-agent}"
if [ ! -d "$PI_PKG" ]; then
	echo "tests/setup.sh: pi package not found at $PI_PKG (set PI_PKG=<path>)" >&2
	exit 1
fi

mkdir -p node_modules/@earendil-works
ln -sfn "$PI_PKG" node_modules/@earendil-works/pi-coding-agent
ln -sfn "$PI_PKG/node_modules/@earendil-works/pi-tui" node_modules/@earendil-works/pi-tui
ln -sfn "$PI_PKG/node_modules/typebox" node_modules/typebox

echo "tests: linked runtime deps into node_modules/ (pi-coding-agent, pi-tui, typebox)"