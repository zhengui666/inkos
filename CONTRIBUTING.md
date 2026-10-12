# Contributing

InkOS retains three packages: `core`, `cli`, and `studio`. Use Node ≥22.19.0 and pnpm 11.3.0.

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm test:flows
pnpm --filter @actalk/inkos-studio test:e2e
pnpm test:install
```

Install a Playwright Chromium browser for e2e (`pnpm --filter @actalk/inkos-studio exec playwright install chromium`), or set `INKOS_BROWSER_EXECUTABLE` to an installed Chrome executable. Tests use actual official SDK, SQLite, filesystem, subprocesses and browser tools; do not replace them with successful model scripts, fake SDKs or fake publishing sites.

- Put execution in official pi-durable tasks/conversations. Do not introduce another Agent loop, scheduler, lease system, transcript recovery or client execution database.
- Put work plans, professional structures, artifact references and distribution intent in domain Documents. Keep large content in stable-version files.
- Implement tools/tasks with official Extension. New content profiles can supply `parseDomain`; new publishers declare their actual capabilities.
- Keep Studio server as assembly and domain routes as thin RPC/SSE adapters. CLI/TUI connect to the same owner.
- Preserve useful domain assertions and original manuscripts/databases. Migrations read originals and write only destination domain data; unknown remote outcomes must be observed.
- Keep changes scoped. Do not add checksums, release proof ledgers, redundant approval chains or a private SDK compatibility layer.
- Local tests must clean their services and temporary projects. Do not use live accounts/models without explicit configuration, scope and fee authorization.

Architecture and deletion decisions belong in `.opensdlc/architecture.md`; migration, executed checks and remaining gaps belong in `.opensdlc/delivery.md`. Historical `.pi/plan/` documents are not rewritten as implementation evidence.

CI runs the commands above and one three-tarball clean-install smoke. Release reuses CI and publishes core, Studio, then CLI with pnpm's native workspace dependency conversion. Local contribution work does not automatically publish, push or deploy.
