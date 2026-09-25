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

## A visual summary for pull requests

`--format github` puts a summary a reviewer can take in at a glance above the report, using only
what GitHub renders natively in a comment or job summary: tables and a Mermaid diagram, no images
to host.

- **Three tiles.** How the changes split across impact tiers, how many touched files changed what
  they export, and how many changes a test moved with.
- **What changed, by kind.** Migrations, models, routes and procedures first, since a reviewer
  reads "1 migration" differently from "26 functions".
- **Blast radius.** The highest-ranked changes grouped by file, the edges between them, and the
  unchanged files that depend on them, collapsed to one node per file so a widely used type does
  not drag in every caller. Test files are marked. It appears only when something depends on
  something else in the change set.
- **Render tree.** For a React project, the pages and components that render what changed, top
  down: the screens an edit reaches, with the changed components marked on the path.
- **Public surface.** Signatures and members before and after, for exported symbols.
- **Files.** Ranked by their most important change and flagged `surface`, `new` or `n untested`:
  a reading order for the diff.

The full report follows, folded. Sections drop from the bottom up when the whole would not fit in
a GitHub comment. With `--per-commit`, an overview table of the commits leads. The dependency data
behind the graphs is in `--format json` as `graph`.

## Posting it on pull requests

A workflow can run the review on every pull request and post it as one comment, updated in place
on each push, and as the run's job summary. `base...head` reviews what the branch did since it
diverged, so commits that landed on the base branch in the meantime do not count against it.

```yaml
name: Review
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0 # both ends of the range must be reachable
      - uses: actions/setup-node@v6
        with:
          node-version: '24'
      - name: Review the pull request
        env:
          BASE: ${{ github.event.pull_request.base.sha }}
          HEAD: ${{ github.event.pull_request.head.sha }}
        run: |
          npx hiarky review "$BASE...$HEAD" --format github > hiarky-review.md
          cat hiarky-review.md >> "$GITHUB_STEP_SUMMARY"
      - name: Annotate the diff
        env:
          BASE: ${{ github.event.pull_request.base.sha }}
          HEAD: ${{ github.event.pull_request.head.sha }}
        run: npx hiarky review "$BASE...$HEAD" --format actions
      - name: Post it as a comment
        continue-on-error: true # a fork's token is read-only; the summary remains
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          PR: ${{ github.event.pull_request.number }}
        run: |
          marker='<!-- hiarky-review -->'
          { echo "$marker"; cat hiarky-review.md; } > hiarky-comment.md
          existing="$(gh api "repos/$REPO/issues/$PR/comments" --paginate \
            --jq "first(.[] | select(.body | startswith(\"$marker\")) | .id)" | head -n 1)"
          if [ -n "$existing" ]; then
            gh api -X PATCH "repos/$REPO/issues/comments/$existing" -F body=@hiarky-comment.md > /dev/null
          else
            gh api "repos/$REPO/issues/$PR/comments" -F body=@hiarky-comment.md > /dev/null
          fi
```

The comment is found again by the marker on its first line, so each push edits it rather than
adding another. A pull request from a fork gets a read-only token, so the comment step is allowed
to fail and the job summary remains.

`--format actions` prints one [workflow command](https://docs.github.com/actions/reference/workflow-commands-for-github-actions)
per change worth a look, so the same findings appear as annotations on the changed lines of the
diff: a warning where no test moved with the change, a notice otherwise. The runner shows ten of
each per step, so the most important ten go out and the comment has the rest.

The hiarky repository runs this workflow on itself, and additionally snapshots every commit of
the range with `backfill` and uploads the viewer as an artifact linked from the summary; see
[its workflow](https://github.com/kosminog/hiarky/blob/main/.github/workflows/review.yml).

## Output formats

| Flag | Use |
| --- | --- |
| *(default)* | Terminal text |
| `--format md` | Markdown, for a PR comment |
| `--format github` | Markdown with a visual summary on top, for a PR comment or job summary |
| `--format actions` | GitHub Actions workflow commands: one annotation per change worth a look, on its line |
| `--format json` | The full data, for tooling |
| `--per-commit` | One section per commit in the range |
