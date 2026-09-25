# Getting started

## Install

```sh
npm install -g hiarky
```

Or run it without installing:

```sh
npx hiarky snap
```

### Requirements

- **Node.js 18 or newer** is required.
- **git** is optional. Without it, snapshots carry no commit metadata. `backfill`, `install-hook`
  and `review <range>` need it.
- **python3** is optional and only used for scanning Python files. Without an interpreter on
  `PATH`, `.py` files are recorded by hash only.

## Your first snapshot

Run hiarky from anywhere inside your project. It walks up to the nearest `package.json`.

```sh
hiarky snap      # record what the project declares
hiarky view      # open the viewer in a browser
```

Make a change, snapshot again, and see what changed:

```sh
hiarky snap
hiarky review
```

## Keep history automatically

```sh
hiarky install-hook   # snapshot on every git commit
hiarky backfill       # snapshot past commits, dated by each commit's own timestamp
hiarky watch          # snapshot whenever source files change
```

Identical snapshots are skipped, so none of these flood the history.

## Review a branch

```sh
hiarky review main..HEAD
hiarky review main..HEAD --format md   # markdown for a PR comment
hiarky review main..HEAD --format github # with a visual summary on top
```

See [Reviewing changes](./review) for what the report contains.

## Try the demo

From a clone of the repository:

```sh
cd examples/demo-app
hiarky snap
# edit a component, then
hiarky snap
hiarky view
```
