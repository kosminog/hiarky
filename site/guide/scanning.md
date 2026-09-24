# Scanning and caching

## What gets scanned

Inside a git repository, hiarky scans only files git would show: tracked files plus untracked files
that are not ignored. Generated clients and build output never reach a snapshot, whatever they are
called.

On top of that, these are always skipped: `node_modules`, `dist`, `build`, `out`, `.next`,
`coverage`, `generated`, `.turbo`, `vendor`, `.hiarky`, minified bundles and declaration files.

Test files are **not** skipped. They are part of the review.

## The analysis cache

Analysing a range of commits re-reads mostly identical trees, so each file's analysis is cached by
content under `.hiarky/cache/`. Fingerprints come from a single `git ls-files -s` call instead of
re-reading the project. Only files git reports as modified are hashed directly.

On a nine-commit `--per-commit` review of a real monorepo, the cache cut the run from 4.8s to 2.3s.

Pass `--no-cache` to `snap`, `review` or `backfill` to bypass it, or delete `.hiarky/cache/`. It is
derived data and has its own `.gitignore`. Neither the cache nor the snapshots count as
working-tree changes, so a snapshot taken on a clean checkout is still recorded as clean.
