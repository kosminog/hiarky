# hiarky

Track what your project declares — components, routes, API procedures, database models, migrations, config — and how it changes over time.

`hiarky snap` statically analyzes your project and records every module-scope symbol, with its dependencies, as a YAML snapshot in `.hiarky/snapshots/`. `hiarky view` generates a self-contained HTML viewer to browse and compare snapshots across time (and commits).

React components are a first-class symbol kind — the viewer still shows the component tree — but they are no longer the only thing recorded, so changes to server code, types, and constants show up too.

## Install

```sh
npm install -g hiarky
```

Or run it without installing:

```sh
npx hiarky snap
```

### Requirements

- **Node.js 18 or newer** — required.
- **git** — optional. Without it, snapshots simply carry no commit metadata; `backfill`,
  `install-hook`, and `review <range>` need it.
- **python3** — optional, and only for scanning Python files. Without an interpreter on `PATH`,
  `.py` files are recorded by hash alone instead of by symbol.

## Usage

From anywhere inside your project (hiarky walks up to the nearest `package.json`):

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
| `kind` | `component`, `function`, `class`, `type`, `const`, `route`, `procedure`, `model`, `migration`, `config` |
| `export` | `default`, `named`, or `none` |
| `signature` | normalized parameters and return type, for functions |
| `members` | component props, interface/enum members, class members, object-literal keys |
| `hooks` | every `useX(...)` call, with the bound variable name (`useState → count`) |
| `edges` | `renders` (JSX children), `calls` (project functions and imports), `extends`, `references` |
| `role` | tags such as `client` / `server` (from `"use client"`), `class` for class components |
| `route` | URL a page or handler serves: `/dashboard/company/:id`, `GET /api/health` |
| `bodyHash` | hash of the declaration's source, so body-only edits are detected |

Components are recognized as before: function, arrow, `memo`/`forwardRef`-wrapped, and class components. Props come from destructured parameters and TypeScript annotations (inline literals plus same-file interfaces/type aliases); class components use `this.props.x` accesses.

### Python

Python files are analyzed with the interpreter's own `ast` module, so the parse is always the
language's own: module-level functions (signatures with annotations **and defaults**), classes
(members, base classes, pydantic-style typed fields tagged `schema`), constants, and calls between
project modules. Relative imports (`from .model import X`) resolve like any other import, so a
Python call graph links up across files.

Decorators become roles (`lru_cache`, `async`), and route decorators become `route` symbols:
`@app.post("/classify")` reads as `POST /classify` for FastAPI, and Flask's
`@app.route("/items", methods=["POST"])` works too.

Visibility follows Python's own conventions: `__all__` when a module defines it, otherwise the
leading-underscore rule.

One interpreter run covers the whole scan. If `python3` is missing or a file will not parse, that
file still gets a hash-only symbol and an entry in the snapshot's `errors`, so it shows as changed
rather than silently disappearing.

### Beyond JavaScript

Files that are not code still decide how a system behaves, so they are recorded as symbols too:

| File | Symbols |
| --- | --- |
| `schema.prisma` | one per model (fields with types, `@@index`/`@@unique`, relations as `references` edges), enum, and datasource/generator block |
| `prisma/migrations/**/*.sql` | one per migration, with a one-line summary of each statement |
| `package.json` | `scripts`, `dependencies`, `devDependencies` — a dependency bump shows as `-react@^18 +react@^19` |
| `.env.example` | variable **names only**, never values |
| `compose.yaml` | one per service, with its settings |
| `pyproject.toml`, `Cargo.toml` | one per section, plus one per dependency list — a dependency reads as `+torch>=2.3.0` |

### Tests

Test files are scanned like any other source. Each top-level `describe` (or `suite`/`context`)
becomes a `test` symbol whose members are its cases, nested ones joined as `outer > inner`; cases
declared outside any suite are gathered under the file's name. Everything declared in a test file
carries the `test` role, in every language.

A suite's edges record **what it exercises** — the runner's own API (`describe`, `expect`, `vi`, …)
is filtered out — so `hiarky review` can answer the question reviewers otherwise ask by hand:

```
changed  routers/company.ts#companyRouter.update  [procedure · mutation · protected]  (no test change)
           input: +tier
```

Coverage follows the dependency graph two hops, so a suite that exercises a root router also covers
the procedures it mounts. Three states are reported: a covering suite changed (no marker), suites
cover it but none changed (`no test change`), or nothing references it (`no tests reference this`).
The headline counts them: `12 added · 20 changed · 5 without a test change`.

Two honest limits: schema, migrations, and config are exempt, since no test imports a Prisma model
or `package.json` and the marker would fire on every one of them; and browser-driven tests
(Playwright and friends) import nothing from the app, so they register no coverage.

### Everything else

Languages without a dedicated extractor get a shallow declaration scan, so no source file is
invisible to a review: **Go, Rust, Java, Kotlin, C#, Swift, PHP, and shell**. It records top-level
declarations — functions, methods (named after their receiver, `Server.Start`), types with their
fields or methods, constants — with each language's own visibility rule (Go's capitalization,
Rust's `pub`, Java's `public`). A Rust `impl` block merges into the type it implements.

It records no call graph and does not understand nesting beyond one level: enough to see *what
changed where*, not the depth TypeScript or Python get. Anything that needs more should get its own
extractor behind the same interface.

### Framework shapes

Two patterns are recognized rather than flattened into "a function" and "a const":

- **Next.js App Router** — `app/**/page.tsx` and `route.ts` become `route` symbols carrying the URL
  they serve. Route groups `(shell)` and parallel slots `@modal` are dropped, `[id]` becomes `:id`,
  and catch-alls become `*slug`. A page is still the top of its render tree.
- **tRPC** — `createTRPCRouter({ … })` yields one `procedure` symbol per key, tagged
  `query`/`mutation` and `protected`/`public`, with the zod input field names as its members. So a
  procedure gaining a required input reads as `input: +tier`, not as "a const changed". Mounted
  sub-routers become `references` edges.

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

Per-file results are cached by content (see below), so re-analyzing history only parses what
actually changed between commits.

What the report gives you, in order:

- **Field-level deltas** — `props: +subtitle`, `signature: (a) → (a, b)`, `members: +tier`, not just
  "changed". Long lists are truncated in the report and complete in `--format json`.
- **Move and rename detection** — a removal and an addition that share a body hash are reported as
  one move. Without this, moving a directory reads as if everything was rewritten.
- **Impact ranking** — export, kind, route, and signature changes outrank edge and hook changes,
  which outrank body-only edits; anything on the public surface is weighted up. Migrations, models,
  routes, and procedures count as public whatever their file exports, and a new environment
  variable is weighted above the dependency bumps it sits beside. Each entry carries the reasons it
  scored where it did.
- **Grouping that matches how code is read** — brand-new files summarize as one line each, test
  changes get their own section listing the cases added and removed, and body-only changes collapse
  into a single closing section.

## The viewer

`hiarky view` embeds all snapshots into a single `.hiarky/view.html` (no server, no network):

- Timeline sidebar listing every snapshot with commit info and diff badges (`+added`, `−removed`, `~changed` vs the previous snapshot)
- Collapsible component tree with added/changed markers; recursive renders and unresolved/external components handled
- An **Other symbols** section grouping every non-component symbol by file, with the same change markers
- Detail panel per symbol: file, signature, members, hooks, and clickable `renders` / `calls` targets
- Navigate between snapshots with ← / →

## The analysis cache

Analyzing a range of commits re-reads mostly identical trees, so each file's analysis is cached by
its content under `.hiarky/cache/`. Git already hashes every tracked file, so the fingerprints come
from one `git ls-files -s` call rather than from re-reading the project; only files git reports as
modified are hashed directly.

On a nine-commit `--per-commit` review of a real monorepo this cut the run from 4.8s to 2.3s. Pass
`--no-cache` to `snap`, `review`, or `backfill` to bypass it, or delete `.hiarky/cache/` — it is
derived data and carries its own `.gitignore`.

Neither the cache nor the snapshots count as working-tree changes: a snapshot taken on a clean
checkout is still recorded as clean.

## Ignored while scanning

Inside a git repository, hiarky scans only files git would show (tracked, plus untracked files that
are not ignored) — so generated clients and build output never reach a snapshot, whatever they are
called. On top of that: `node_modules`, `dist`, `build`, `out`, `.next`, `coverage`, `generated`,
`.turbo`, `vendor`, `.hiarky`, minified bundles, and declaration files. Test files are **not**
ignored — they are part of the review.

## Try the demo

From a clone of this repository:

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
diffing, the viewer — works on that shape, so a new language is a single new file registered in
`src/extractors/index.ts`.

An extractor with a fixed cost per invocation can also implement `analyzeMany(files)`; a scan then
calls it once for all its files instead of once per file. That is how the Python extractor spawns
one interpreter for the whole project.

## Development

```sh
git clone https://github.com/kosminog/hiarky.git
cd hiarky
npm install
npm run build
npm link   # makes the `hiarky` command available globally from this checkout
npm test   # vitest suite: analyzer, linking, diffing, CLI, git, watch, viewer
```

`npm run dev` rebuilds on change; `npm run typecheck` type-checks without emitting.

## Roadmap

- A tree-sitter backend to deepen the shallow-scanned languages (call graphs, nested declarations)
- Per-symbol history and compare-any-two-snapshots in the viewer
