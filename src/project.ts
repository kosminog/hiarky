import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import fg from 'fast-glob';
import { GitInfo } from './types';

/** Directories that hold dependencies, build output or tool state, wherever they sit. */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hiarky',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  'generated',
  '.turbo',
  'vendor',
]);
/** Generated files that sit beside source. */
const IGNORED_SUFFIXES = ['.min.js', '.d.ts'];

/** Never scanned, in or out of a git repository; as globs, for walking a directory. */
export const IGNORE = [
  ...[...IGNORED_DIRS].map((dir) => `**/${dir}/**`),
  ...IGNORED_SUFFIXES.map((suffix) => `**/*${suffix}`),
];

/** Does a project-relative path fall under IGNORE? */
function isIgnored(rel: string): boolean {
  const dirs = rel.split('/');
  const base = dirs.pop() ?? '';
  return (
    dirs.some((dir) => IGNORED_DIRS.has(dir)) ||
    IGNORED_SUFFIXES.some((suffix) => base.endsWith(suffix))
  );
}

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

export interface FindFilesOptions {
  /** Which listed files to keep, by project-relative path */
  match: (rel: string) => boolean;
  /** The same files as globs, for walking a directory outside git */
  globs: string[];
  /** Outside git, match dotfiles and walk hidden directories too */
  dot?: boolean;
}

function isFile(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * Project files, relative to root and sorted, skipping IGNORE.
 *
 * In a git repository (`gitFiles` from listGitFiles) they come from git's list,
 * so nothing git ignores is walked: a checkout can hold gigabytes of ignored
 * worktrees, caches and virtualenvs. Elsewhere the directory is walked.
 */
export function findProjectFiles(
  root: string,
  gitFiles: Set<string> | null,
  opts: FindFilesOptions
): string[] {
  if (gitFiles) {
    // The index can list files that are gone from disk, or a submodule's directory
    return [...gitFiles]
      .filter((rel) => opts.match(rel) && !isIgnored(rel) && isFile(path.join(root, rel)))
      .sort();
  }
  const dot = opts.dot ?? false;
  return fg
    .sync(opts.globs, {
      cwd: root,
      // Without dot nothing in a hidden directory matches, so skip walking its contents
      ignore: dot ? IGNORE : [...IGNORE, '**/.*/**'],
      dot,
    })
    .sort();
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
