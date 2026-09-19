import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { findProjectRoot, readProjectName } from './project';
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

export async function runBackfill(opts: { max: number; range?: string }): Promise<void> {
  const root = findProjectRoot(process.cwd());
  if (!root) {
    console.error('hiarky: no package.json found in this directory or any parent.');
    process.exitCode = 1;
    return;
  }

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
    console.error(`hiarky: not a git repository with commits (${err instanceof Error ? err.message.split('\n')[0] : err}).`);
    process.exitCode = 1;
    return;
  }
  if (commits.length === 0) {
    console.log('No commits to backfill.');
    return;
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

  let written = 0;
  let skippedExisting = 0;
  let skippedSame = 0;
  let skippedMissing = 0;
  let prevHash: string | null = null;

  try {
    git(repoRoot, ['worktree', 'add', '--detach', '--force', worktree, commits[0]]);

    for (const sha of commits) {
      if (existing.has(sha)) {
        skippedExisting++;
        prevHash = existing.get(sha)!;
        continue;
      }

      git(worktree, ['checkout', '--detach', '--force', '--quiet', sha]);
      const projDir = path.join(worktree, relProject);
      if (!fs.existsSync(path.join(projDir, 'package.json'))) {
        skippedMissing++;
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
        skippedSame++;
        continue;
      }
      prevHash = snapshot.contentHash!;

      writeSnapshot(root, snapshot);
      written++;
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
  if (skippedExisting) skipped.push(`${skippedExisting} already snapshotted`);
  if (skippedSame) skipped.push(`${skippedSame} unchanged`);
  if (skippedMissing) skipped.push(`${skippedMissing} without the project`);
  console.log(
    `Backfill complete: ${written} snapshot(s) written` +
      (skipped.length ? ` (skipped ${skipped.join(', ')})` : '') +
      '.'
  );
}
