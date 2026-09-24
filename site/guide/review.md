# Reviewing changes

`hiarky review` answers "what actually changed here?" for a branch, a commit range, or the last two
snapshots.

```sh
hiarky review main..HEAD
```

Endpoints that already have a clean snapshot reuse it. The rest are analysed in a temporary git
worktree, so your working tree is never touched and the project's own git hooks never fire. The
review is then narrowed to files the range touched (`--all-files` to opt out).

## What the report contains

- **Field-level deltas.** `props: +subtitle`, `signature: (a) → (a, b)`, `members: +tier`, not just
  "changed". Long lists are truncated in the report and complete in `--format json`.
- **Move and rename detection.** A removal and an addition with the same body hash are reported as
  one move, so moving a directory does not read as a rewrite.
- **Impact ranking.** Export, kind, route and signature changes outrank edge and hook changes,
  which outrank body-only edits. Anything on the public surface is weighted up. Migrations, models,
  routes and procedures count as public whatever their file exports. Each entry lists the reasons
  for its score.
- **Grouping that matches how code is read.** New files summarise as one line each, test changes
  get their own section listing cases added and removed, and body-only changes collapse into a
  closing section.

## Test coverage

```
changed  routers/company.ts#companyRouter.update  [procedure · mutation · protected]  (no test change)
           input: +tier
```

Coverage follows the dependency graph two hops, so a suite that exercises a root router also covers
the procedures it mounts. Each changed symbol is in one of three states:

- a covering suite changed (no marker)
- suites cover it but none changed (`no test change`)
- nothing references it (`no tests reference this`)

The headline counts them: `12 added · 20 changed · 5 without a test change`.

Schema, migrations and config are exempt, since no test imports a Prisma model or `package.json`.
Browser-driven tests (Playwright and similar) import nothing from the app, so they register no
coverage.

## Output formats

| Flag | Use |
| --- | --- |
| *(default)* | Terminal text |
| `--format md` | Markdown, for a PR comment |
| `--format json` | The full data, for tooling |
| `--per-commit` | One section per commit in the range |
