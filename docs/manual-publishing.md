# Manual publishing packages (first adapter)

InkOS can freeze explicitly selected chapter revisions, produce a local TXT/Markdown/EPUB package, and keep platform book/chapter mappings and author-reported receipts in SQLite. It does **not** sign in, upload, click Publish, accept agreements, or verify remote status. Six manual capabilities are listed: 番茄小说, 起点中文网, 七猫中文网, MegaNovel, GoodNovel and Dreame / Stary Writing. No authorized automatic-submission integration is available for them. A verified ordinary-author write API has not been identified or integrated; this is not a claim that none can exist.

This first slice exposes a CLI and a TypeScript API. Agent tool registration, Studio UI, authorized remote publishing and online receipt verification are future integrations. No background publishing process is installed.

## Prepare a package

Use an existing canonical Work (`inkos work list`). Each selection is an explicit text/Markdown artifact revision representing one chapter. Explicit draft selections can be exported without first adopting them. Historical revisions are allowed when their retained snapshots are readable. This does not infer chapter boundaries or publish every artifact in the Work.

```sh
inkos publishing capabilities --json
inkos work show my-book --json
# Supply an existing platform book ID and a local label identifying your account.
# Never pass a password, cookie, access token or other credential.
inkos publishing map-book fanqie platform-book-id my-book --account my-author-label --json
```

Save the exact artifact/revision IDs shown by `work show` to `selection.json`:

```json
[
  {"artifactId":"the-artifact-id","revisionId":"the-revision-id","number":1,"title":"初见"},
  {"artifactId":"another-artifact-id","revisionId":"another-revision-id","number":2,"title":"归来"}
]
```

```sh
inkos publishing prepare TARGET_ID --selection selection.json --formats txt,md,epub --json
inkos publishing verify PACKAGE_ID --json
```

The returned directory is `.inkos/publishing/PACKAGE_ID/`:

- `chapters/000001_chapter.md`: exact selected source bytes, bound directly to the registered revision
- `exports/book.txt`, `exports/book.md`, `exports/book.epub`: the selected chapters, in number order, rendered with existing InkOS exporters
- `manifest.json`: immutable target, selected revision IDs and retained file bytes
- `README.txt`: manual instructions and platform guidance

The original manuscripts and Work manifest are unchanged. Later writing cannot change this package. Identical selection/metadata/target/formats reuse the same package. Altered or incomplete packages fail verification and are never silently regenerated. SQLite records the authoritative retained file bytes and staging directory before directory promotion. A reserved staging directory or complete package left by an interruption can be recovered by repeating `prepare` with the same selection, only if every byte still matches that record. An orphan without its database record is rejected. Incomplete hidden staging directories are not submission packages.

Legacy packages keep their original IDs and receipts. `legacyFilesWithoutSnapshot` in the CLI result identifies old export files without retained original bytes; those bytes are not independently proven frozen. No new content digest is calculated.

TXT/Markdown exports can be used for copying/import **only where the current author portal supports that format**. EPUB is also useful for review; platform EPUB import support is not assumed. Platform chapter-length, review, AI disclosure and rights requirements are deliberately not hardcoded from old help pages.

## Manual submission and receipt

First inspect the package and current state, and verify the platform account/book. Each account label/book mapping is supplied by you; InkOS has not authenticated or remotely verified it. Check rights, exclusivity, originality, AI disclosure and the current portal rules before submitting. A package is not publishing authorization or agreement acceptance.

Before submitting a chapter yourself, persist an attempt:

```sh
inkos publishing show PACKAGE_ID --json
inkos publishing begin PACKAGE_ID 1 --version 0 --event-id chapter-1-attempt-1 --json
# Now the author submits this exact chapter through the official author portal.
inkos publishing receipt PACKAGE_ID 1 --version 1 --event-id chapter-1-receipt-1 \
  --status submitted_reported --remote-chapter PLATFORM_CHAPTER_ID \
  --evidence 'Author checked the review queue: awaiting review.' --json
```

`begin` writes `awaiting_receipt` **before** the external manual step. It does not perform that step. Each command uses the current package-state version from `show`, so competing updates cannot silently overwrite one another. Event IDs make exact recording retries idempotent; they never grant permission to repeat the external submission. If the external step may have happened, reconcile its result first.

Record publication only after checking the actual chapter status:

```sh
inkos publishing receipt PACKAGE_ID 1 --version 2 --event-id chapter-1-publication-1 \
  --status published_reported --remote-chapter PLATFORM_CHAPTER_ID \
  --evidence 'Author checked this chapter in the platform: published.' --json
```

Every manual receipt is `user_reported`, and `remoteVerified` always remains `false`. `submitted_reported` is not `published_reported`. The latter requires a platform chapter ID. Another revision or number of the same mapped artifact, or another artifact using the same chapter number, cannot start a new submission while an attempt is unresolved or recorded as submitted/published. Remote chapter IDs cannot silently change or be reused for a different local chapter.

If a portal timed out, record `submission_unknown` with what happened. Do not resend. Inspect drafts, review queues and published chapters on the platform. Only if the author confirms that no submission exists can `not_submitted_reported` release that chapter for another manual attempt. A known submitted/published record cannot be reset to absent. Editing/retracting already submitted chapters is outside this first adapter.

```sh
inkos publishing receipt PACKAGE_ID 1 --version CURRENT_VERSION --event-id checked-absent \
  --status not_submitted_reported --evidence 'Author checked drafts and review queue: no submission exists.' --json
inkos publishing targets --json
inkos publishing list --target TARGET_ID --json
```

Receipts may contain a non-secret reference or URL. Never put credentials or unnecessary personal information in labels, receipts or packages. Packages contain manuscript text and local target labels; share them only with the intended recipient.

## TypeScript API

`ManualPublishingAdapter`, `PublishingStore`, schemas and `listPublishingCapabilities` are exported from `@actalk/inkos-core`. Open a store at the project's existing `.inkos/harness.sqlite`, construct the adapter with the project root and store, and call `mapBook`, `prepare`, `verify`, `beginSubmission` and `recordReceipt`. Close the store afterward. There are no network dependencies or remote API placeholders in this adapter. Keep lifecycle operations through the adapter so package integrity is checked before beginning manual submission.

## Platform sources

These links guide the author; the package does not assert current contractual eligibility:

- 番茄: [low-quality AI content policy](https://fanqienovel.com/writer/zone/article/7602950185735438398), [exclusivity/first publication](https://fanqienovel.com/writer/zone/help/article?rank1=10226&rank2=10227&rank3=0). The cited AI policy is not treated as a blanket prohibition on all AI-assisted writing
- 起点: [author help](https://help.yuewen.com/help?siteId=2), [Yuewen partner content distribution](https://open.yuewen.com/docs/1003.html). Content-distribution endpoints are not assumed to be author chapter-write APIs
- 七猫: [author agreement](https://zhushou.qimao.com/writer-rules/68464fdfe4a81e7ec312f874/), [original publishing rules](https://zhushou.qimao.com/writer-rules/68466f6ae4a81e7ec312f8cd/). Unapproved third-party access and AI disclosure require attention; manual file preparation makes no platform request
