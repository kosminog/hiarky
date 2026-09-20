import { nullCache, openCache } from './cache';
import { readProjectName } from './project';
import {
  analyzeProject,
  buildSnapshot,
  loadSnapshots,
  snapshotHash,
  writeSnapshot,
} from './snap';
import { gitOut as git, readRepo, withWorktree } from './worktree';

export interface BackfillResult {
  written: number;
  skippedExisting: number;
  skippedSame: number;
  skippedMissing: number;
}

export async function backfillProject(
  root: string,
  opts: { max: number; range?: string; noCache?: boolean }
): Promise<BackfillResult> {
  const repo = readRepo(root);
  const { repoRoot, branch } = repo;
  let commits: string[];
  try {
    const range = opts.range ?? 'HEAD';
    const list = git(root, ['rev-list', '--reverse', range]);
    commits = list ? list.split('\n') : [];
  } catch (err) {
    throw new Error(
      `cannot list commits (${err instanceof Error ? err.message.split('\n')[0] : err}).`
    );
  }
  const result: BackfillResult = {
    written: 0,
    skippedExisting: 0,
    skippedSame: 0,
    skippedMissing: 0,
  };
  if (commits.length === 0) {
    console.log('No commits to backfill.');
    return result;
  }
  if (opts.max > 0 && commits.length > opts.max) {
    commits = commits.slice(-opts.max); // most recent N, still oldest → newest
  }

  // Commits already snapshotted (clean snapshots only)
  const existing = new Map<string, string>(); // sha -> content hash
  for (const s of loadSnapshots(root)) {
    if (s.git && !s.git.dirty) existing.set(s.git.commit, snapshotHash(s));
  }

  const projectName = readProjectName(root);
  console.log(`Backfilling ${commits.length} commit(s) via temporary worktree ...`);

  let prevHash: string | null = null;
  // Anchored at the project, not the worktree, so it survives the run and is
  // reused by the next one; most files are identical between adjacent commits.
  const cache = opts.noCache ? nullCache() : openCache(root);

  await withWorktree(repo, commits[0], async (wt) => {
    for (const sha of commits) {
      if (existing.has(sha)) {
        result.skippedExisting++;
        prevHash = existing.get(sha)!;
        continue;
      }

      const projDir = wt.checkout(sha);
      if (!projDir) {
        result.skippedMissing++;
        continue;
      }

      const analysis = await analyzeProject(projDir, { cache });
      const snapshot = buildSnapshot(analysis, {
        root,
        name: projectName,
        git: { commit: sha, branch, dirty: false },
        timestamp: new Date(git(repoRoot, ['show', '-s', '--format=%cI', sha])),
      });

      if (snapshot.contentHash === prevHash) {
        result.skippedSame++;
        continue;
      }
      prevHash = snapshot.contentHash!;

      writeSnapshot(root, snapshot);
      result.written++;
      console.log(
        `  ${sha.slice(0, 7)}  ${snapshot.timestamp}  ${snapshot.stats.symbols} symbols`
      );
    }
  });
  cache.flush();

  const skipped: string[] = [];
  if (result.skippedExisting) skipped.push(`${result.skippedExisting} already snapshotted`);
  if (result.skippedSame) skipped.push(`${result.skippedSame} unchanged`);
  if (result.skippedMissing) skipped.push(`${result.skippedMissing} without the project`);
  console.log(
    `Backfill complete: ${result.written} snapshot(s) written` +
      (skipped.length ? ` (skipped ${skipped.join(', ')})` : '') +
      '.'
  );
  return result;
}
