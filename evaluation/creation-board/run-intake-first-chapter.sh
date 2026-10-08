#!/usr/bin/env bash
set -euo pipefail
MODE=${1:---dry-run}
BASE=$(cd -- "$(dirname -- "$0")" && pwd)
if [[ "$MODE" == --dry-run ]]; then
  echo 'Prepared only: real two-field semantic planner → foundation → first chapter review'
  echo 'Product model: gpt-6.1-sol / ultra / priority; no publisher or UI/HTTP claim'
  exit 0
fi
[[ "$MODE" == --execute ]] || { echo 'Use --dry-run or --execute' >&2; exit 2; }
: "${INKOS_CLI:?Set the exact final integrated candidate compiled CLI}"
: "${INKOS_CODEX_HOME:?Set only the verified previously authorized Inkos account home}"
: "${INKOS_SOURCE_PROJECT:?Set the verified existing authorized Inkos service project root}"
: "${RUN_ROOT:?Set a new isolated output directory}"
[[ "$INKOS_CLI" = /* && -f "$INKOS_CLI" && "$INKOS_CODEX_HOME" = /* && -d "$INKOS_CODEX_HOME" ]] || exit 2
[[ "$RUN_ROOT" = /* && ! -e "$RUN_ROOT" ]] || { echo 'Refusing an existing or relative run directory' >&2; exit 2; }
[[ "$INKOS_SOURCE_PROJECT" = /* && -d "$INKOS_SOURCE_PROJECT" ]] || { echo 'Source project must be an existing verified absolute path' >&2; exit 2; }
PROBE_ARGS=(--cli "$INKOS_CLI" --project "$INKOS_SOURCE_PROJECT" --expect-model gpt-6.1-sol --expect-effort ultra --expect-tier priority)
if [[ -n "${INKOS_STUDIO_PID:-}" ]]; then PROBE_ARGS+=(--studio-pid "$INKOS_STUDIO_PID"); fi
if ! EXISTING_PREFLIGHT=$(node "$BASE/safe-runtime-preflight.mjs" "${PROBE_ARGS[@]}"); then
  printf '%s\n' "$EXISTING_PREFLIGHT"
  echo 'Existing service runtime/account route is blocked; no evaluation project or inference was started' >&2
  exit 3
fi
mkdir -p -- "$RUN_ROOT";export INKOS_CODEX_HOME
printf '%s\n' "$EXISTING_PREFLIGHT" > "$RUN_ROOT/preflight-existing.json"
cd -- "$RUN_ROOT"
node "$INKOS_CLI" init project --lang zh > init.log 2>&1
cd project;mkdir -p .inkos
printf '%s\n' '{"model":"gpt-6.1-sol","reasoningEffort":"ultra","serviceTier":"priority"}' > .inkos/codex-config.json
node "$BASE/safe-runtime-preflight.mjs" --cli "$INKOS_CLI" --project "$PWD" \
  --expect-model gpt-6.1-sol --expect-effort ultra --expect-tier priority > ../preflight-isolated.json

node "$BASE/run-intake-first-chapter.mjs" "$INKOS_CLI" "$BASE/intake-fixture.json" "$RUN_ROOT/intake-report.json" > ../intake.log 2>&1
