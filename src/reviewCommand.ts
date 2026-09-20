import { renderMarkdown, renderText, ReportContext } from './report';
import { readProjectName } from './project';
import { Review, reviewSnapshots } from './review';
import { analyzeProject, buildSnapshot, loadSnapshotEntries } from './snap';
import { Snapshot } from './types';
import { gitOut, readRepo, RepoInfo, withWorktree } from './worktree';

export type ReviewFormat = 'text' | 'md' | 'json';

export interface ReviewCommandOptions {
  /** `a..b`, `a...b`, or a single rev meaning `<rev>..HEAD` */
  range?: string;
  format: ReviewFormat;
  /** Report each commit in the range separately */
  perCommit?: boolean;
  /** Include symbols in files the range never touched */
  allFiles?: boolean;
}

interface Endpoints {
  base: string;
  head: string;
}

/** Resolve a range expression into two commit shas. */
export function resolveRange(root: string, range: string): Endpoints {
  const rev = (r: string) => gitOut(root, ['rev-parse', `${r}^{commit}`]);
  const tripleDot = range.indexOf('...');
  if (tripleDot > 0) {
    const left = range.slice(0, tripleDot);
    const right = range.slice(tripleDot + 3) || 'HEAD';
    // `a...b` reviews what b added since the branches diverged
    return { base: gitOut(root, ['merge-base', rev(left), rev(right)]), head: rev(right) };
  }
  const doubleDot = range.indexOf('..');
  if (doubleDot > 0) {
    const left = range.slice(0, doubleDot);
    const right = range.slice(doubleDot + 2) || 'HEAD';
    return { base: rev(left), head: rev(right) };
  }
  return { base: rev(range), head: rev('HEAD') };
}

/** Project-relative files the range touched, as git sees them. */
function changedFiles(root: string, base: string, head: string): string[] {
  const out = gitOut(root, ['diff', '--name-only', '--relative', base, head]);
  return out ? out.split('\n').filter(Boolean) : [];
}

function emptySnapshot(root: string, name: string, sha: string, branch: string): Snapshot {
  return buildSnapshot(
    { filesScanned: 0, filesWithSymbols: 0, symbols: [], roots: [], errors: [] },
    { root, name, git: { commit: sha, branch, dirty: false }, timestamp: new Date(0) }
  );
}

/**
 * Snapshots for a set of commits, reusing any already on disk and analyzing
 * the rest in one temporary worktree.
 */
async function snapshotsForCommits(
  root: string,
  repo: RepoInfo,
  shas: string[]
): Promise<Map<string, Snapshot>> {
  const name = readProjectName(root);
  const result = new Map<string, Snapshot>();

  // Clean snapshots already recorded for these commits
  const onDisk = new Map<string, Snapshot>();
  for (const s of loadSnapshotEntries(root).map((e) => e.snapshot)) {
    if (s.git && !s.git.dirty) onDisk.set(s.git.commit, s);
  }

  const missing: string[] = [];
  for (const sha of shas) {
    const existing = onDisk.get(sha);
    if (existing) result.set(sha, existing);
    else missing.push(sha);
  }
  if (missing.length === 0) return result;

  await withWorktree(repo, missing[0], async (wt) => {
    for (const sha of missing) {
      const projDir = wt.checkout(sha);
      if (!projDir) {
        // The project did not exist yet at this commit
        result.set(sha, emptySnapshot(root, name, sha, repo.branch));
        continue;
      }
      const analysis = await analyzeProject(projDir);
      result.set(
        sha,
        buildSnapshot(analysis, {
          root,
          name,
          git: { commit: sha, branch: repo.branch, dirty: false },
          timestamp: new Date(gitOut(repo.repoRoot, ['show', '-s', '--format=%cI', sha])),
        })
      );
    }
  });
  return result;
}

function render(review: Review, ctx: ReportContext, format: ReviewFormat): string {
  if (format === 'json') return JSON.stringify({ ...ctx, review }, null, 2);
  return format === 'md' ? renderMarkdown(review, ctx) : renderText(review, ctx);
}

function subjectOf(root: string, sha: string): string {
  try {
    return gitOut(root, ['show', '-s', '--format=%s', sha]);
  } catch {
    return sha.slice(0, 7);
  }
}

/** Review the two most recent snapshots on disk — no git required. */
function reviewLatestSnapshots(root: string, format: ReviewFormat): string {
  const entries = loadSnapshotEntries(root);
  if (entries.length < 2) {
    throw new Error(
      'need at least two snapshots to review. Run `hiarky snap` again, or pass a commit range ' +
        '(e.g. `hiarky review main..HEAD`).'
    );
  }
  const prev = entries[entries.length - 2].snapshot;
  const next = entries[entries.length - 1].snapshot;
  const label = (s: Snapshot) =>
    s.git ? s.git.commit.slice(0, 7) + (s.git.dirty ? '*' : '') : s.timestamp.slice(0, 19) + 'Z';
  return render(reviewSnapshots(prev, next), { from: label(prev), to: label(next) }, format);
}

/** Render a review of a commit range, or of the latest two snapshots. */
export async function reviewProject(
  root: string,
  opts: ReviewCommandOptions
): Promise<string> {
  if (!opts.range) return reviewLatestSnapshots(root, opts.format);

  const repo = readRepo(root);
  const { base, head } = resolveRange(root, opts.range);
  const list = gitOut(root, ['rev-list', '--reverse', `${base}..${head}`]);
  const commits = list ? list.split('\n') : [];

  if (opts.perCommit) {
    const shas = [base, ...commits];
    const snapshots = await snapshotsForCommits(root, repo, shas);
    const sections: string[] = [];
    const jsonSections: unknown[] = [];

    for (let i = 1; i < shas.length; i++) {
      const prevSha = shas[i - 1];
      const sha = shas[i];
      const files = opts.allFiles ? undefined : changedFiles(root, prevSha, sha);
      const review = reviewSnapshots(snapshots.get(prevSha)!, snapshots.get(sha)!, { files });
      if (review.changes.length === 0) continue;
      const ctx: ReportContext = {
        from: prevSha.slice(0, 7),
        to: sha.slice(0, 7),
        files: files?.length,
        title: `${sha.slice(0, 7)} — ${subjectOf(root, sha)}`,
      };
      if (opts.format === 'json') jsonSections.push({ commit: sha, ...ctx, review });
      else sections.push(render(review, ctx, opts.format));
    }

    if (opts.format === 'json') return JSON.stringify(jsonSections, null, 2);
    if (sections.length === 0) {
      return `No symbol-level changes across ${commits.length} commit(s).\n`;
    }
    return sections.join(opts.format === 'md' ? '\n---\n\n' : '\n');
  }

  const snapshots = await snapshotsForCommits(root, repo, [base, head]);
  const files = opts.allFiles ? undefined : changedFiles(root, base, head);
  const review = reviewSnapshots(snapshots.get(base)!, snapshots.get(head)!, { files });
  const ctx: ReportContext = {
    from: base.slice(0, 7),
    to: head.slice(0, 7),
    commits: commits.length,
    files: files?.length,
  };
  return render(review, ctx, opts.format);
}
