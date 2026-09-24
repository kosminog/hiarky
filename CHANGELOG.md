# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.4

### Added

- hiarky has a logo. `hiarky view` pages show it as their browser-tab icon, embedded in the file so
  the viewer still works offline, and it follows the browser's light or dark setting.

## 0.1.3

### Fixed

- tRPC procedures whose input is a schema declared elsewhere (`.input(listSchema)`) now list its
  fields. Schemas are followed through imports, barrels and namespace imports, and through
  `z.object(shape)`, `.extend`, `.merge`, `.pick`, `.omit` and `...base.shape` spreads. Zod object
  schemas declared as consts list their fields too, so the first review after upgrading reports
  their members as changed.
- Next.js route handlers exported under a method alias (`export { handler as GET, handler as POST }`)
  are now recorded as routes, one per method, each referencing the shared handler. Handlers imported
  or re-exported into a `route.ts` (`export { GET } from "…"`) are recorded too.
- Imports of a declaration exported under another name (`export { Inner as Outer }`,
  `export { x as default }`) now link to that declaration.
- The analysis cache format changed; existing caches are discarded and rebuilt on the next scan.

## 0.1.2

No functional changes to the CLI.

- Releases now publish through npm trusted publishing (OIDC), so CI authenticates without a token
  and attaches a provenance attestation.
- `dist/index.js` gets its executable bit restored after every build, and the build's clean step no
  longer depends on a Unix shell, so `npm run build` behaves the same on Windows.

0.1.1 was tagged but never published.

## 0.1.0

First public release.

### Added

- `hiarky snap` — statically analyzes a project and records every module-scope symbol, with its
  dependencies, as a YAML snapshot in `.hiarky/snapshots/`. Snapshots are content-deduplicated, and
  each symbol carries a body hash, so a change inside a function body counts as a change.
- `hiarky view` — generates a self-contained HTML viewer to browse and compare snapshots across
  time and commits.
- `hiarky review [range]` — impact-ranked, field-level summaries of what changed, as text, markdown,
  or JSON, over a git range or the last two snapshots. `--per-commit` reports each commit
  separately.
- `hiarky list` and `hiarky prune --keep <n>` — inspect and trim snapshot history.
- `hiarky watch` — debounced auto-snapshot on source changes.
- `hiarky install-hook` / `uninstall-hook` — snapshot on every commit via a git post-commit hook.
- `hiarky backfill` — retroactively snapshot past commits in a temporary git worktree, dated by each
  commit's own timestamp.
- Language extractors: JavaScript/TypeScript/JSX via Babel, Python via the interpreter's own `ast`
  module, plus SQL, Prisma, TOML, and JSON/config. Unknown languages are shallow-scanned.
- Framework awareness: routes, API procedures, tRPC procedures, database models, and migrations are
  recorded as first-class symbols.
- Tests are recorded as symbols, and a change that shipped without a corresponding test change is
  flagged in review.
- Content-addressed per-file analysis cache under `.hiarky/cache`, fingerprinted from `git ls-files`
  so unchanged files are never re-analyzed.
- Monorepo and workspace resolution from `package.json#workspaces` and `pnpm-workspace.yaml`.

### Requirements

- Node.js 18 or newer. `git` is optional (needed for `backfill`, `install-hook`, and reviewing a
  range); `python3` is optional (without it, `.py` files are recorded by hash alone).
