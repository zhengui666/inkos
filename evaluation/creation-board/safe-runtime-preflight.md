# Safe runtime preflight for the selected Inkos build

This evaluation helper checks the actual production-text configuration and existing
app account, without starting an inference thread or turn. It does not run `doctor`,
`doctor --provider`, global-config display, login/logout, refresh-token requests, or
settings writes. Do not use it to discover or borrow another person's account.

## Command and integration

Use an explicit absolute compiled CLI path and an existing, authorized Inkos project
root containing `inkos.json`:

```sh
node "$BASE/safe-runtime-preflight.mjs" \
  --cli "$INKOS_CLI" \
  --project "$INKOS_SOURCE_PROJECT" \
  --expect-model gpt-6.1-sol \
  --expect-effort ultra \
  --expect-tier priority > "$PREFLIGHT_REPORT"
```

If a previously authorized `INKOS_CODEX_HOME` was supplied, preserve that exact
absolute path; it must already exist. Never replace it with personal `CODEX_HOME`,
copy credentials, or initialize a new account home. The helper does not infer
permission from the mere existence of a configured path. Run only against the
service/project and app account the user authorized.

The helper follows the selected Core's existing global `.env`, project `.env`, and
process-environment precedence using `loadLLMEnvLayers(project, {...process.env})`.
Hydration is confined to that clone. It reads the app-specific `INKOS_CODEX_HOME`
and `INKOS_CODEX_STATE_ROOT` configuration and the build's exported
`resolveCodexHome`; it never falls back to the personal `CODEX_HOME`. A configured
path must be absolute. The resolved home and its direct parent must already be
private, owned, non-symlink directories. The helper checks `auth.json` metadata
only; it never opens, parses, copies, or prints its contents. The exact verified
home is then pinned with `createCodexClient(project, {codexHome})`.

Check the existing service project before creating an evaluation project or
changing evaluation settings. Once an isolated project has been explicitly
prepared, check it again with the same selected CLI and authorized account home
before any inference. Shell callers should use the exit status rather than grep a
human-readable status line.

- Exit `0`: native Codex route, existing app auth, ChatGPT account, catalog support,
  and all supplied exact expectations passed
- Exit `3`: blocked; the JSON's allowlisted `errorCode` identifies the reason

The expectation flags are optional for inspection. Evaluation gates should always
supply all three. `providerRoute` is always required to be
`codex-native-chatgpt`; an older or incompatible build cannot silently pass.

## What the output means

Exactly one JSON record is emitted, with only these top-level keys:

- `providerRoute`: verified effective production-text route, or `null` before it
  could be established
- `model`: saved/effective Codex model until catalog resolution; on a successful
  catalog check, the actual catalog-selected model identifier, including an
  explicit `model: null` catalog-default choice
- `reasoningEffort`, `serviceTier`: effective saved settings merged with this
  selected Core's defaults; no reinterpretation of `priority` as `fast`
- `settingsSource`: `project-codex-config+core-defaults` or `core-defaults`
- `accountSource`: safe labels such as `process-inkos-codex-home`,
  `project-env-inkos-codex-home`, `global-env-inkos-codex-home`, the corresponding
  `inkos-state-root-home` labels, or `existing-project-codex-home`
- `authPresent`: a regular, non-symlink app `auth.json` exists; this alone does not
  establish a usable account
- `authAvailable`: `account/read` returned a connected ChatGPT account
- `catalogSupported`: `selectCodexModel` accepted the effective model, effort, and
  tier against `model/list`
- `errorCode`: `null` on success, otherwise a fixed allowlisted code
- `runtime`: fixed version/launch-source metadata, observed native exit status, and
  fixed diagnostic categories, described below
- `studioContext`: optional fixed launch-context comparison, described below

The helper uses the selected Core's `resolveEffectiveLLMConfig` with the same
`purpose: 'codex'` used by production text, `readCodexSettings`,
`createCodexAccountService`, and `selectCodexModel`. Legacy `llm.defaultModel`,
provider endpoints, and legacy per-worker overrides are not reported as the
actual text model. No account email, plan, raw error, raw environment/config,
credentials, catalog descriptions, full PATH, or arbitrary provider response is emitted.
Dependency stdout/stderr diagnostics are suppressed at the CLI boundary.

### Native launch diagnostics

`runtime` contains `codexExpectedVersion`, `codexInstalledVersion`, `launcherPath`,
`launcherSource`, `nodeVersion`, `nodeExecutable`, `nodeExecutableSource`,
`pathSource`, `nativeSpawnObserved`, `exitCode`, `signal`, `exitDuringShutdown`, and
`diagnosticCategories`. Paths are limited to the selected package's launcher and
Node executable. The package is resolved from the selected Core exactly as its
App Server does; `/usr/bin/codex` or a shell's `codex --version` is never substituted.
Missing or nonmatching pinned dependencies fail with `CODEX_RUNTIME_DEPENDENCY`.

The helper instruments only its matched selected-package App Server spawn and
restores the original Node spawn binding afterward. It classifies incoming stderr
chunks into `read-only-filesystem`, `unsupported-argument`, `config-rejected`,
`permission`, or `runtime-dependency`; unknown account/catalog runtime failure is
reported as `unknown-runtime-failure`. Raw chunks are never saved or output. These
are diagnostic clues, not proof that a particular warning caused the exit. No
matched text means unknown, not an inferred authentication or model problem.
`exitDuringShutdown` separates intentional disposal from a spontaneous exit.

### Compare the verified existing Studio process

On Linux, append an explicitly verified Studio PID when the probe must establish
whether it is using the same launch context:

```sh
node "$BASE/safe-runtime-preflight.mjs" \
  --cli "$INKOS_CLI" --project "$INKOS_SOURCE_PROJECT" \
  --studio-pid 2071782 \
  --expect-model gpt-6.1-sol --expect-effort ultra --expect-tier priority
```

Use a PID only after verifying it identifies the intended existing Studio. The
helper checks `/proc/PID/cwd` against the exact project before reading environment
records. It reads the executable link and incrementally retains only app-home,
PATH/HOME, and native-runtime environment allowlist keys from `/proc/PID/environ`.
All other values are discarded, and no environment values are emitted. Current
project/global `.env` layers are read into a clone for the comparison; a different
HOME blocks instead of borrowing the helper's global configuration location.

`studioContext` contains `requested`, `available`, `cwdMatches`,
`nodeExecutableMatches`, `accountHomeMatches`, `pathMatches`,
`runtimeEnvironmentMatches`, `nodeExecutable`, and `environmentSource`. Comparisons
are booleans or `null` when unavailable; the only value path is the executable.
A differing cwd, executable, account home, PATH, or relevant launch environment
fails with `STUDIO_LAUNCH_CONTEXT_MISMATCH` before starting native App Server.
An unavailable/non-Linux proc context fails with `STUDIO_CONTEXT_UNAVAILABLE`.
No setting, account path, environment, or runtime is silently switched to make a
comparison pass. `authPresent` can still be true while `authAvailable` is false
because a context mismatch prevented the account request.

Important limit: `/proc/PID/environ` exposes startup environment, not arbitrary
later changes to the process's environment. The explicit output source is
`proc-startup-env+current-env-files`. This checks current on-disk configuration
against the observable launch context; it cannot prove a running process has not
retained earlier settings or changed environment internally. A comparison failure
is not evidence that Studio is signed out. Only an account check in a verified
matching context establishes `authAvailable`.

The supported build layout is the inspected monorepo's
`packages/cli/dist/index.js` paired with `packages/core/dist`. The helper verifies
that the CLI's linked `@actalk/inkos-core` is that same Core, and requires its
readiness/configuration exports plus the exported app-home resolver. Missing or
mismatched capabilities fail closed; there is no PATH/global/alternate-build
fallback.

## Read-only scope and limits

The only account/catalog operations are `account/read` with `refreshToken: false`
and `model/list`. Native App Server performs its required initialization handshake.
The wrapper rejects any other service-issued RPC. It never starts `thread/start`
or `turn/start` and does not perform generation.

Starting App Server can create temporary work directories and update its native
runtime/cache files in an existing authorized account home. Therefore this is
read-only at the account/catalog operation level, not a filesystem no-write
promise. The helper neither creates a missing account home nor repairs directory
permissions. The checks are a point-in-time readiness gate; they cannot prove a
later generation succeeds or stop another process changing configuration later.
`authAvailable` confirms local account availability, not an inference billing or
end-to-end model health test.

## Local mocked verification

```sh
node --check evaluation/creation-board/safe-runtime-preflight.mjs
node --test evaluation/creation-board/safe-runtime-preflight.test.mjs
```

All test runtime operations are mocked. Tests use the built Core's real settings,
account projection, catalog selection, and effective-route resolver with isolated
fixtures under this evaluation directory. No native Codex process, remote account
request, inference, login, logout, or credential content read is performed.
