# Observation-only publishing preflight

```sh
inkos publishing preflight WORK_ID --chapter N --config preflight.json --json
```

WORK_ID can be omitted only if exactly one Work exists. N selects an existing current chapter, not a new test manuscript. Exit 0 means the observed remote chapter matched the current retained revision. Missing chapters, mismatches and incomplete observations exit 1. Neither result permits submission or retry.

The report always declares `observationOnly: true`, `publicationAuthorized: false`, `targetMappingChecked: false`, and `retainedAttemptsChecked: false`. It does not check saved publication mappings, attempt history, required canonical replay, editorial approval or publishing permission. A negative observation cannot exclude an earlier unknown submission arriving later.

## Separate observation configuration

```json
{
  "version": 1,
  "bindings": [{
    "provider": "meganovel",
    "workId": "YOUR_EXISTING_WORK_ID",
    "configuration": {
      "endpointURL": "http://127.0.0.1:9222",
      "scope": {
        "sessionId": "ACTUAL_AUTHORIZED_CDP_TARGET_ID",
        "accountId": "ACTUAL_ACCOUNT_ID",
        "accountLabel": "YOUR_LOCAL_LABEL",
        "remoteBookId": "ACTUAL_REMOTE_BOOK_ID"
      },
      "lockDirectory": "/absolute/shared/browser-locks",
      "authorization": {
        "automation": {"provenance": "user_reported", "reference": "Existing authorization reference"},
        "aiAssistedContent": {"provenance": "user_reported", "reference": "Existing truthful declaration reference"}
      },
      "dom": {"knownChapters": []}
    }
  }]
}
```

These are placeholders, not valid account or chapter identities. Existing transport authorization requirements remain in force. Use an already-authorized numeric loopback endpoint and actual target. No endpoint/browser launch, login, account discovery, credential collection, security setting or policy change is performed. This feature does not repair or bypass a Chrome-extension policy failure.

The configuration is strict and distinct from scheduler publication configuration: no targetId, packageId, submission intent or domBindingModule. Whole-table shape and unique Work routing are checked; only the selected Work's provider configuration is parsed or connected. The default registry supports only the existing native MegaNovel provider. Other platforms fail explicitly as unsupported; synthetic registry tests are not additional integrations.

The native binding requires an existing saved chapter editor or independently observed knownChapters in the existing DOM schema. Unsupported UI, pagination, account/book mismatch, pending unsaved editors, agreements, authentication and uncertain public readback fail closed. Never invent IDs to satisfy these checks.

## Local and remote boundaries

- No harness.sqlite is opened, and no PublishingStore or ManualPublishingAdapter is constructed
- No package, Goal, scheduler, reservation or receipt is created or updated
- No reconcile, saveDraft, createDraft, submit or unknown-submission retry is called
- The exact parsed preflight CLI bypasses global atomic recovery; pending transaction directories cause an error without recovery or cleanup
- The real current Work revision needs retained snapshot/inline bytes matching its live source; same-path, symlink and hardlink aliases of the live file are rejected as non-independent snapshot evidence; Work identity and real-path containment are checked, then identity and bytes are rechecked after observation
- Supported source chapters are current registered source/chapters/NNNN_*.md files with the existing English/Chinese document wrapper transform
- Probe and DOM observation reuse native read-only navigation and the existing short-lived CDP ownership lock, including normal disconnect/lock cleanup
- Reports contain identifiers, booleans, observed status and fixed safe errors, not manuscript text, credentials, configuration, endpoint URLs, raw evidence or raw exceptions

The existing dom-v1 snapshot contract keeps its real mutation Intent. A separate optional observeSnapshot capability takes only scope/chapter/title/optional actual chapter ID; the native binding implements it. A legacy custom module without it is explicitly rejected for pure observation, never called through a silent fallback. The durable adapter and preflight share pure identity/body comparison.

## Validation scope

Synthetic source, browser-port and CLI tests require no account or real manuscript. They do not constitute real-platform acceptance. See the candidate's current validation report for freshly executed results; historical results from any earlier candidate must not be reused.
