import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { GitInfo } from './types';

/** findProjectRoot, but throws when no project is found (CLI entry points). */
export function requireProjectRoot(from: string = process.cwd()): string {
  const root = findProjectRoot(from);
  if (!root) throw new Error('no package.json found in this directory or any parent.');
  return root;
}

/** Walk up from cwd to the nearest directory containing package.json. */
export function findProjectRoot(from: string): string | null {
  let dir = path.resolve(from);
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readProjectName(root: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (typeof pkg.name === 'string' && pkg.name) return pkg.name;
  } catch {
    // fall through to directory name
  }
  return path.basename(root);
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

export function readGitInfo(root: string): GitInfo | null {
  try {
    const commit = git(root, ['rev-parse', 'HEAD']);
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const dirty = git(root, ['status', '--porcelain']).length > 0;
    return { commit, branch, dirty };
  } catch {
    return null; // not a git repo, or no commits yet
  }
}
