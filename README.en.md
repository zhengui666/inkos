# InkOS 2

A durable content creation and independent distribution platform. Novels, short fiction, scripts, storyboards, interactive worlds, translation and articles share one project runtime. CLI, TUI and Studio are clients, not separate execution engines.

Requires Node **22.19.0+**; repository development uses **pnpm 11.3.0**. This development branch has not published a new npm release.

```sh
npm install -g @actalk/inkos
inkos init --lang fr-FR
inkos up
inkos work create --id manuscript --title 'My manuscript' --locale fr-FR --review '{"enabled":false}'
inkos write manuscript --file ./draft.txt --request-id imported-draft --wait
inkos tasks tree
inkos down
```

The example imports an author manuscript without model inference. For generation, use `models list`, `models login <provider>`, and `models set <provider> <model-id>`. Supported API-key/OAuth providers and routing come from official pi-ai. Model and image calls may incur fees.

A Work needs no platform. Author intent and professional structures are preserved; reviews and bounded necessary revisions precede stable file versions. Pause persists a boundary intention; cancellation uses native abort. Closing a client never cancels background work. Changes to a submitted/published artifact require explicit `operation:update`.

Browser publishers use official pi-mcp/Playwright MCP, account/target-owned sessions, persisted intentions and observation-first uncertainty recovery. Submitted, reviewing and published are separate outcomes. Login and other user actions suspend only the affected distribution.

See [operations/configuration](docs/runtime.md), [complete CLI reference](packages/cli/README.md), [architecture](.opensdlc/architecture.md), and [actual local acceptance/live gaps](.opensdlc/delivery.md). The [Chinese README](README.md) provides the complete introduction. Historical changelogs describe earlier versions, not current commands.

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm test:flows
pnpm --filter @actalk/inkos-studio test:e2e
pnpm test:install
```

Local checks use real SDK, SQLite, files, processes and browser tools. No live model or MegaNovel account chain was configured or executed for this delivery. These checks do not certify model quality or remote publication.

[AGPL-3.0-only](LICENSE).
