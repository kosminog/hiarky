import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { readProjectName } from './project';
import {
  analyzeProject,
  buildSnapshot,
  loadSnapshots,
  snapshotHash,
  writeSnapshot,
} from './snap';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

export interface BackfillResult {
  written: number;
  skippedExisting: number;
  skippedSame: number;
  skippedMissing: number;
}

export async function backfillProject(
  root: string,
  opts: { max: number; range?: string }
): Promise<BackfillResult> {
  let repoRoot: string;
  let branch: string;
  let commits: string[];
  try {
    repoRoot = git(root, ['rev-parse', '--show-toplevel']);
    branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const range = opts.range ?? 'HEAD';
    const list = git(root, ['rev-list', '--reverse', range]);
    commits = list ? list.split('\n') : [];
  } catch (err) {
    throw new Error(
      `not a git repository with commits (${err instanceof Error ? err.message.split('\n')[0] : err}).`
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

  // Where the project lives inside the repo (e.g. "" or "examples/demo-app")
  const relProject = path.relative(repoRoot, root);

  // Commits already snapshotted (clean snapshots only)
  const existing = new Map<string, string>(); // sha -> content hash
  for (const s of loadSnapshots(root)) {
    if (s.git && !s.git.dirty) existing.set(s.git.commit, snapshotHash(s));
  }

  const projectName = readProjectName(root);
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'hiarky-backfill-'));
  console.log(`Backfilling ${commits.length} commit(s) via temporary worktree ...`);

  let prevHash: string | null = null;

  try {
    git(repoRoot, ['worktree', 'add', '--detach', '--force', worktree, commits[0]]);

    for (const sha of commits) {
      if (existing.has(sha)) {
        result.skippedExisting++;
        prevHash = existing.get(sha)!;
        continue;
      }

      git(worktree, ['checkout', '--detach', '--force', '--quiet', sha]);
      const projDir = path.join(worktree, relProject);
      if (!fs.existsSync(path.join(projDir, 'package.json'))) {
        result.skippedMissing++;
        continue;
      }

      const analysis = await analyzeProject(projDir);
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
        `  ${sha.slice(0, 7)}  ${snapshot.timestamp}  ${snapshot.stats.components} components`
      );
    }
  } finally {
    try {
      git(repoRoot, ['worktree', 'remove', '--force', worktree]);
    } catch {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  }

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
