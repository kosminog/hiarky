# hiarky

Track your React project's component hierarchy, props, and hooks over time through snapshots.

`hiarky snap` statically analyzes your source (JS/JSX/TS/TSX) and records the component tree as a YAML snapshot in `.hiarky/snapshots/`. `hiarky view` generates a self-contained HTML viewer to browse and compare snapshots across time (and commits).

## Install

```sh
npm install
npm run build
npm link   # makes the `hiarky` command available globally
npm test   # run the vitest suite (analyzer, hierarchy linking, diffing)
```

## Usage

From anywhere inside a React project (hiarky walks up to the nearest `package.json`):

```sh
hiarky snap            # take a snapshot (skipped if nothing changed; --force to override)
hiarky view            # generate .hiarky/view.html and open it in a browser
hiarky view --no-open  # generate without opening
hiarky list            # table of snapshots: timestamp, commit, components, changes
hiarky prune --keep 20 # delete old snapshots, keeping the newest 20 (--dry-run to preview)
hiarky watch           # auto-snapshot on source changes (--debounce <ms>, default 1500)
hiarky install-hook    # snapshot on every git commit (post-commit hook; uninstall-hook to remove)
hiarky backfill        # retroactively snapshot past commits (--max <n>, --range <rev-range>)
```

Snapshots are content-deduplicated: a snapshot identical to the previous one (same components,
props, hooks, and hierarchy) is skipped, so watch mode and commit hooks never flood the history.
`backfill` analyzes each past commit in a temporary git worktree and dates the snapshot by the
commit's own timestamp, so the viewer timeline shows real project history.

## What a snapshot captures

For every React component found (function, arrow, `memo`/`forwardRef`-wrapped, and class components):

- **Hierarchy** — which components render which, resolved through import statements (not name-guessing). Components from packages are tagged with their package name.
- **Props** — from destructured parameters and TypeScript type annotations (inline literals, plus same-file interfaces/type aliases). Class components: `this.props.x` accesses.
- **Hooks** — every `useX(...)` call, with the bound variable name where available (e.g. `useState → count`).
- **Metadata** — timestamp, UUID, git commit/branch/dirty flag, file and component counts.

Snapshots are stored as `.hiarky/snapshots/<timestamp>-<uuid>.snapshot` (YAML — human-readable and git-diffable).

## The viewer

`hiarky view` embeds all snapshots into a single `.hiarky/view.html` (no server, no network):

- Timeline sidebar listing every snapshot with commit info and diff badges (`+added`, `−removed`, `~changed` vs the previous snapshot)
- Collapsible component tree with added/changed markers; recursive renders and unresolved/external components handled
- Detail panel per component: file, props, hooks, and clickable rendered children
- Navigate between snapshots with ← / →

## Ignored while scanning

`node_modules`, `dist`, `build`, `out`, `.next`, `coverage`, `.hiarky`, declaration files, and test files (`*.test.*`, `*.spec.*`, `__tests__`, `__mocks__`).

## Try the demo

```sh
cd examples/demo-app
hiarky snap
# edit a component, then:
hiarky snap
hiarky view
```

## Roadmap

- Runtime capture of live prop/state values
- Smarter hierarchy resolution (barrel files, tsconfig path aliases, workspaces)
- Per-component history view and compare-any-two-snapshots in the viewer
