#!/usr/bin/env bash
# Local bundle only; Node owns argument, path, package and version validation.
if [ -z "${BASH_VERSION:-}" ]; then
  echo 'Bash 3.2 or newer is required' >&2
  exit 1
fi
if (( BASH_VERSINFO[0] < 3 || (BASH_VERSINFO[0] == 3 && BASH_VERSINFO[1] < 2) )); then
  echo 'Bash 3.2 or newer is required' >&2
  exit 1
fi
script="${BASH_SOURCE[0]}"
if [[ "$script" == */* ]]; then directory="${script%/*}"; else directory=.; fi
directory="$(cd -P -- "$directory" && pwd)" || exit 1
exec node "$directory/install-bundle.mjs" "$@"
