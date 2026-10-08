#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 1 || "$1" != /* || ! -f "$1/package.json" || ! -f "$1/pnpm-lock.yaml" ]]; then
  echo 'Usage: bash build-evaluation-cli.sh /absolute/path/to/isolated/baseline-or-candidate-source' >&2
  exit 2
fi
ROOT=$(cd -- "$1" && pwd)
[[ -d "$ROOT/node_modules" ]] || { echo 'Dependencies must already be materialized in this isolated source tree. Do not borrow a different build or copy credentials. Have the executor verify the approved install/setup route first.' >&2; exit 3; }
command -v pnpm >/dev/null || { echo 'pnpm is required; verify the executor toolchain before building' >&2; exit 3; }
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22 || (major===22&&minor<16))process.exit(3)'
cd -- "$ROOT"
pnpm build
[[ -f "$ROOT/packages/cli/dist/index.js" && -f "$ROOT/packages/core/dist/index.js" ]] || { echo 'Build output is incomplete' >&2; exit 4; }
node "$ROOT/packages/cli/dist/index.js" --version
printf 'INKOS_CLI=%s/packages/cli/dist/index.js\n' "$ROOT"
