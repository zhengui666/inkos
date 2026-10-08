#!/usr/bin/env bash
set -euo pipefail
MODE=${1:---dry-run}
CASE_ID=${2:-case-01}
BUILD_LABEL=${3:-candidate}
BASE=$(cd -- "$(dirname -- "$0")" && pwd)
case "$MODE" in --dry-run|--execute) ;; *) echo 'Use --dry-run or --execute' >&2; exit 2;; esac
case "$CASE_ID" in case-0[1-6]) ;; *) echo 'Unknown case' >&2; exit 2;; esac
case "$BUILD_LABEL" in baseline|candidate) ;; *) echo 'Unknown build label' >&2; exit 2;; esac
if [[ "$MODE" == --dry-run ]]; then
  printf 'Prepared only: %s, %s, gpt-6.1-sol / ultra / priority\n' "$CASE_ID" "$BUILD_LABEL"
  printf 'Input: %s/%s.txt\nNo model, account, filesystem mutation, or publication operation was executed\n' "$BASE" "$CASE_ID"
  exit 0
fi
: "${INKOS_CLI:?Set the verified compiled CLI path for this build}"
: "${INKOS_CODEX_HOME:?Set the explicitly authorized Inkos account home; never copy credentials}"
: "${INKOS_SOURCE_PROJECT:?Set the verified existing authorized Inkos service project root}"
: "${RUN_ROOT:?Set a new isolated output directory}"
[[ "$INKOS_CLI" = /* && -f "$INKOS_CLI" ]] || { echo 'CLI must be a verified absolute built file' >&2; exit 2; }
[[ "$INKOS_CODEX_HOME" = /* && -d "$INKOS_CODEX_HOME" ]] || { echo 'Authorized account home must already exist' >&2; exit 2; }
[[ "$RUN_ROOT" = /* && ! -e "$RUN_ROOT" ]] || { echo 'Refusing an existing or relative run directory' >&2; exit 2; }
[[ "$INKOS_SOURCE_PROJECT" = /* && -d "$INKOS_SOURCE_PROJECT" ]] || { echo 'Source project must be an existing verified absolute path' >&2; exit 2; }
PROBE_ARGS=(--cli "$INKOS_CLI" --project "$INKOS_SOURCE_PROJECT" --expect-model gpt-6.1-sol --expect-effort ultra --expect-tier priority)
if [[ -n "${INKOS_STUDIO_PID:-}" ]]; then PROBE_ARGS+=(--studio-pid "$INKOS_STUDIO_PID"); fi
if ! EXISTING_PREFLIGHT=$(node "$BASE/safe-runtime-preflight.mjs" "${PROBE_ARGS[@]}"); then
  printf '%s\n' "$EXISTING_PREFLIGHT"
  echo 'Existing service runtime/account route is blocked; no evaluation project or inference was started' >&2
  exit 3
fi
mkdir -p -- "$RUN_ROOT"
export INKOS_CODEX_HOME
printf '%s\n' "$EXISTING_PREFLIGHT" > "$RUN_ROOT/preflight-existing.json"
node - "$BASE/semantic-fixtures.json" "$CASE_ID" "$RUN_ROOT" "$BUILD_LABEL" "$INKOS_CLI" <<'NODE'
const fs=require('node:fs'),path=require('node:path');
const [manifest,id,root,label,cli]=process.argv.slice(2);
const item=JSON.parse(fs.readFileSync(manifest,'utf8')).find(x=>x.id===id);
if(!item) throw Error('Unknown fixture');
fs.writeFileSync(path.join(root,'input.txt'),item.brief+'\n',{flag:'wx'});
fs.writeFileSync(path.join(root,'run-manifest.json'),JSON.stringify({status:'prepared',label,fixture:item,createdAt:new Date().toISOString(),cli,settings:{model:'gpt-6.1-sol',reasoningEffort:'ultra',serviceTier:'priority'}},null,2)+'\n',{flag:'wx'});
NODE
get_field() { node -e 'const d=require(process.argv[1]);process.stdout.write(String(d.fixture[process.argv[2]]))' "$RUN_ROOT/run-manifest.json" "$1"; }
LANGUAGE=$(get_field language)
TITLE=$(get_field title)
GENRE=$(get_field genre)
COUNT=$(get_field chapters)
LENGTH=$(get_field chapterLength)
cd -- "$RUN_ROOT"
node "$INKOS_CLI" init project --lang "$LANGUAGE" > init.log 2>&1
cd project
mkdir -p .inkos
printf '%s\n' '{"model":"gpt-6.1-sol","reasoningEffort":"ultra","serviceTier":"priority"}' > .inkos/codex-config.json
node "$BASE/safe-runtime-preflight.mjs" --cli "$INKOS_CLI" --project "$PWD" \
  --expect-model gpt-6.1-sol --expect-effort ultra --expect-tier priority > ../preflight-isolated.json

node "$INKOS_CLI" book create --title "$TITLE" --genre "$GENRE" --platform other --lang "$LANGUAGE" --target-chapters "$COUNT" --chapter-words "$LENGTH" --brief ../input.txt --json > ../foundation.log 2>&1
# The isolated project contains exactly one work, so use documented auto-detection.
node "$INKOS_CLI" write next --count "$COUNT" --words "$LENGTH" --context-file ../input.txt --json > ../writing.log 2>&1
node - "$RUN_ROOT/run-manifest.json" <<'NODE'
const fs=require('node:fs');const p=process.argv[2],v=JSON.parse(fs.readFileSync(p,'utf8'));
v.status='cli-finished-awaiting-artifact-verification-and-blind-reading';v.finishedAt=new Date().toISOString();fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n');
NODE
printf 'CLI run finished for %s %s; verify actual chapters and blind-read before claiming quality\n' "$BUILD_LABEL" "$CASE_ID"
