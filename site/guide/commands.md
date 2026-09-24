# Commands

| Command | What it does |
| --- | --- |
| `hiarky snap` | Take a snapshot. Skipped if nothing changed; `--force` to override. |
| `hiarky view` | Generate `.hiarky/view.html` and open it. `--no-open` to only generate. |
| `hiarky review [range]` | Show what changed between the last two snapshots, or across a git range. |
| `hiarky list` | Table of snapshots: timestamp, commit, components, changes. |
| `hiarky prune --keep <n>` | Delete old snapshots, keeping the newest `n`. `--dry-run` to preview. |
| `hiarky watch` | Snapshot automatically when sources change. `--debounce <ms>`, default 1500. |
| `hiarky install-hook` | Snapshot on every git commit via a post-commit hook. |
| `hiarky uninstall-hook` | Remove that hook. |
| `hiarky backfill` | Snapshot past commits. `--max <n>`, `--range <rev-range>`. |

`snap`, `review` and `backfill` accept `--no-cache` to bypass the
[analysis cache](./scanning#the-analysis-cache).

## `review` options

```sh
hiarky review                          # last two snapshots (no git needed)
hiarky review main..HEAD               # everything on this branch
hiarky review main...HEAD              # since the branches diverged
hiarky review v1.2.0                   # a single rev means <rev>..HEAD
hiarky review main..HEAD --format md   # markdown, for a PR comment
hiarky review main..HEAD --format json # the full data, for tooling
hiarky review main..HEAD --per-commit  # one section per commit
hiarky review main..HEAD --all-files   # don't narrow to files the range touched
```
