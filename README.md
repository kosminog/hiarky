# hiarky

Track what your project's code declares — components, functions, classes, types, constants — and how it changes over time.

`hiarky snap` statically analyzes your source (JS/JSX/TS/TSX) and records every module-scope symbol, with its dependencies, as a YAML snapshot in `.hiarky/snapshots/`. `hiarky view` generates a self-contained HTML viewer to browse and compare snapshots across time (and commits).

React components are a first-class symbol kind — the viewer still shows the component tree — but they are no longer the only thing recorded, so changes to server code, types, and constants show up too.

## Install

```sh
npm install
npm run build
npm link   # makes the `hiarky` command available globally
npm test   # run the vitest suite (analyzer, linking, diffing, CLI, git, watch, viewer)
```

## Usage

From anywhere inside a React project (hiarky walks up to the nearest `package.json`):

```sh
hiarky snap            # take a snapshot (skipped if nothing changed; --force to override)
hiarky view            # generate .hiarky/view.html and open it in a browser
hiarky view --no-open  # generate without opening
hiarky review          # what changed between the last two snapshots
hiarky review main..HEAD --format md   # review a commit range, ranked by impact
hiarky list            # table of snapshots: timestamp, commit, components, changes
hiarky prune --keep 20 # delete old snapshots, keeping the newest 20 (--dry-run to preview)
hiarky watch           # auto-snapshot on source changes (--debounce <ms>, default 1500)
hiarky install-hook    # snapshot on every git commit (post-commit hook; uninstall-hook to remove)
hiarky backfill        # retroactively snapshot past commits (--max <n>, --range <rev-range>)
```

Snapshots are content-deduplicated: a snapshot identical to the previous one is skipped, so watch
mode and commit hooks never flood the history. Because each symbol carries a body hash, a change
inside a function body counts as a change — not just changes to props, hooks, or hierarchy.
`backfill` analyzes each past commit in a temporary git worktree and dates the snapshot by the
commit's own timestamp, so the viewer timeline shows real project history.

## What a snapshot captures

Every module-scope declaration becomes a **symbol** with a stable id (`<file>#<name>`):

| Field | What it holds |
| --- | --- |
| `kind` | `component`, `function`, `class`, `type`, or `const` |
| `export` | `default`, `named`, or `none` |
| `signature` | normalized parameters and return type, for functions |
| `members` | component props, interface/enum members, class members, object-literal keys |
| `hooks` | every `useX(...)` call, with the bound variable name (`useState → count`) |
| `edges` | `renders` (JSX children), `calls` (project functions and imports), `extends` |
| `role` | tags such as `client` / `server` (from `"use client"`), `class` for class components |
| `bodyHash` | hash of the declaration's source, so body-only edits are detected |

Components are recognized as before: function, arrow, `memo`/`forwardRef`-wrapped, and class components. Props come from destructured parameters and TypeScript annotations (inline literals plus same-file interfaces/type aliases); class components use `this.props.x` accesses.

**Imports are resolved properly**, so the graph connects in real projects: relative paths, `tsconfig.json` path aliases (`~/*`, jsonc and `extends` chains included), workspace packages (`package.json#workspaces` and `pnpm-workspace.yaml`), and barrel files (`export * from`, `export { X } from`). When a barrel re-exports a third-party package, the edge records that package, not the local alias.

Snapshot metadata carries the timestamp, UUID, git commit/branch/dirty flag, and file/symbol/component counts. Snapshots are stored as `.hiarky/snapshots/<timestamp>-<uuid>.snapshot` (YAML — human-readable and git-diffable). Snapshots written by earlier versions (`hiarky: 1`) are upgraded on read, so an existing history keeps working.

## Reviewing a range of commits

`hiarky review` answers "what actually changed here?" for a branch or a commit range.

```sh
hiarky review                      # last two snapshots (no git needed)
hiarky review main..HEAD           # everything on this branch
hiarky review main...HEAD          # ...since the branches diverged
hiarky review v1.2.0               # a single rev means <rev>..HEAD
hiarky review main..HEAD --format md       # markdown, for a PR comment
hiarky review main..HEAD --format json     # the full data, for tooling
hiarky review main..HEAD --per-commit      # one section per commit
```

Endpoints that already have a clean snapshot reuse it; the rest are analyzed in a temporary git
worktree, so your working tree is never touched and the project's own git hooks never fire. The
review is then narrowed to files the range actually touched (`--all-files` to opt out).

What the report gives you, in order:

- **Field-level deltas** — `props: +subtitle`, `signature: (a) → (a, b)`, `members: +tier`, not just
  "changed". Long lists are truncated in the report and complete in `--format json`.
- **Move and rename detection** — a removal and an addition that share a body hash are reported as
  one move. Without this, moving a directory reads as if everything was rewritten.
- **Impact ranking** — export, kind, and signature changes outrank edge and hook changes, which
  outrank body-only edits; anything on the public surface is weighted up. Each entry carries the
  reasons it scored where it did.
- **Grouping that matches how code is read** — brand-new files summarize as one line each, and
  body-only changes collapse into a single closing section.

## The viewer

`hiarky view` embeds all snapshots into a single `.hiarky/view.html` (no server, no network):

- Timeline sidebar listing every snapshot with commit info and diff badges (`+added`, `−removed`, `~changed` vs the previous snapshot)
- Collapsible component tree with added/changed markers; recursive renders and unresolved/external components handled
- An **Other symbols** section grouping every non-component symbol by file, with the same change markers
- Detail panel per symbol: file, signature, members, hooks, and clickable `renders` / `calls` targets
- Navigate between snapshots with ← / →

## Ignored while scanning

Inside a git repository, hiarky scans only files git would show (tracked, plus untracked files that
are not ignored) — so generated clients and build output never reach a snapshot, whatever they are
called. On top of that: `node_modules`, `dist`, `build`, `out`, `.next`, `coverage`, `generated`,
`.turbo`, `vendor`, `.hiarky`, minified bundles, declaration files, and test files (`*.test.*`,
`*.spec.*`, `__tests__`, `__mocks__`).

## Try the demo

```sh
cd examples/demo-app
hiarky snap
# edit a component, then:
hiarky snap
hiarky view
```

## Adding a language

Extractors are plugins: one object with `globs`, `matches(file)`, and `analyze(abs, rel)` returning
symbols, imports, and re-exports (`src/extractors/`). Everything downstream — linking, snapshotting,
diffing, the viewer — works on that shape, so a Python or schema extractor is a single new file
registered in `src/extractors/index.ts`.

## Roadmap

- `hiarky review <base>..<head>` — field-level diffs, rename/move detection, and impact-ranked
  change summaries for code review, as markdown or JSON
- Declarative extractors (Prisma schema, SQL migrations, `package.json`, `.env.example`) and
  framework recognizers (Next.js routes, tRPC procedures)
- Python extractor, then a tree-sitter fallback for the long tail
- Tests as first-class symbols, so "changed without touching tests" is visible
- Per-file analysis cache keyed by git blob sha, so backfill re-parses only what changed
