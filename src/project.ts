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

/**
 * Files git would show for this directory: tracked, plus untracked files that
 * are not ignored. Returns null outside a git repository.
 *
 * Ignore rules are the project's own statement about what is source and what
 * is build output — honouring them keeps generated bundles (a Prisma client,
 * a compiled bundle) out of snapshots without hiarky having to guess.
 */
export function listGitFiles(root: string): Set<string> | null {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }
    ).toString();
    const files = out.split('\0').filter(Boolean);
    return new Set(files);
  } catch {
    return null;
  }
}

export function readGitInfo(root: string): GitInfo | null {
  try {
    const commit = git(root, ['rev-parse', 'HEAD']);
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    // hiarky's own output is not a working-tree change: snapshots and the
    // analysis cache must never make a clean checkout look dirty.
    const dirty = git(root, ['status', '--porcelain'])
      .split('\n')
      .some((line) => line.trim().length > 0 && !line.slice(3).startsWith('.hiarky/'));
    return { commit, branch, dirty };
  } catch {
    return null; // not a git repo, or no commits yet
  }
}
