import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

export function gitOut(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

/**
 * git with the project's hooks disabled. Analyzing history must not trigger
 * someone's post-checkout automation (husky shims, dependency installs) in a
 * scratch worktree they never asked for.
 */
function gitQuiet(cwd: string, args: string[]): string {
  return gitOut(cwd, ['-c', 'core.hooksPath=/dev/null', ...args]);
}

export interface RepoInfo {
  /** Absolute path of the repository root */
  repoRoot: string;
  /** Where the project sits inside the repo ("" when they are the same) */
  relProject: string;
  branch: string;
}

/** Repository facts for a project directory. Throws outside a git repo. */
export function readRepo(root: string): RepoInfo {
  try {
    const repoRoot = gitOut(root, ['rev-parse', '--show-toplevel']);
    return {
      repoRoot,
      relProject: path.relative(repoRoot, root),
      branch: gitOut(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    };
  } catch (err) {
    throw new Error(
      `not a git repository with commits (${err instanceof Error ? err.message.split('\n')[0] : err}).`
    );
  }
}

export interface Worktree {
  /**
   * Check out a commit and return the project directory inside the worktree,
   * or null when the project does not exist at that commit.
   */
  checkout(sha: string): string | null;
}

/**
 * Run `fn` against a detached temporary worktree, cleaning it up afterwards.
 * Checking out into a scratch worktree leaves the user's working tree alone,
 * so analyzing history never disturbs uncommitted work.
 */
export async function withWorktree<T>(
  repo: RepoInfo,
  startSha: string,
  fn: (wt: Worktree) => Promise<T>
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiarky-worktree-'));
  const worktree: Worktree = {
    checkout(sha: string): string | null {
      gitQuiet(dir, ['checkout', '--detach', '--force', '--quiet', sha]);
      const projDir = path.join(dir, repo.relProject);
      return fs.existsSync(path.join(projDir, 'package.json')) ? projDir : null;
    },
  };

  gitQuiet(repo.repoRoot, ['worktree', 'add', '--detach', '--force', dir, startSha]);
  try {
    return await fn(worktree);
  } finally {
    try {
      gitQuiet(repo.repoRoot, ['worktree', 'remove', '--force', dir]);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
