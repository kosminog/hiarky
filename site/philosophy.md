# Philosophy

<!-- Draft written from the README. Rewrite it in your own voice. -->

## Review what changed, not which lines moved

A line diff tells you *where* text changed. A reviewer needs to know *what* changed: a procedure
gained a required input, a component lost a prop, a migration dropped a column, a dependency jumped
a major version. hiarky records what a project **declares** and compares those declarations, so a
change reads as `input: +tier` instead of a wall of red and green.

## Everything that shapes behaviour counts

Components are only part of a system. Routes, API procedures, database models, migrations,
environment variables and dependency lists decide how it behaves just as much. hiarky treats them
all as symbols, so a change to server code, a schema or `package.json` shows up in the same review
as a change to the UI.

## Rank by impact

Not every change deserves the same attention. hiarky ranks changes to the public surface (exports,
signatures, routes, procedures, models, migrations) above changes to internal edges, and those
above body-only edits. Every entry carries the reasons for its rank, so you can see why it scored
where it did. Moves and renames are detected by body hash, so moving a directory does not look like
rewriting it.

## Be honest about limits

A tool is only trustworthy if it says what it does not know. hiarky's limits are explicit:

- Languages without a dedicated extractor get a shallow declaration scan with no call graph.
- A Python file that will not parse is still recorded by hash and listed under `errors`, so it
  shows as changed instead of disappearing.
- Test coverage is inferred from the dependency graph. Schema, migrations and config are exempt,
  and browser-driven tests register no coverage. hiarky says so instead of guessing.

## Local, plain and quiet

- **No server, no account, no network.** Snapshots are YAML files in `.hiarky/`, and the viewer is
  a single HTML file.
- **Readable and diffable.** You can open a snapshot in an editor or diff it in git.
- **Never floods history.** Identical snapshots are skipped, so watch mode and commit hooks only
  record real changes.
- **Never touches your working tree.** Past commits are analysed in a temporary git worktree, and
  your own git hooks never fire.

## One interface for every language

Every extractor returns the same shape: symbols, imports and re-exports. Linking, snapshotting,
diffing, reviewing and the viewer all work on that shape. Adding a language means adding one file,
not changing the pipeline.
