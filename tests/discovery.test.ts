import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadResolverContext } from '../src/modules';
import { analyzeProject } from '../src/snap';
import { cleanup, initRepo, makeProject, writeFile } from './helpers';

const TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: '.' } });
const PYPROJECT = '[project]\nname = "api"\n';
const HELPER_TS = 'export function helper() {\n  return 1;\n}\n';

/** A project with a full copy of itself in each of `dirs`, as worktree tools leave them. */
function projectWithCopies(dirs: string[]): string {
  const files: Record<string, string> = {};
  for (const dir of ['', ...dirs.map((d) => `${d}/`)]) {
    files[`${dir}tsconfig.json`] = TSCONFIG;
    files[`${dir}api/pyproject.toml`] = PYPROJECT;
    files[`${dir}src/helper.ts`] = HELPER_TS;
  }
  return makeProject(files);
}

// Root reads any directory, so a lock proves nothing there
const CAN_LOCK = process.platform !== 'win32' && process.getuid?.() !== 0;

/** Run fn with these directories unreadable, so walking into one throws EACCES. */
async function withLocked<T>(root: string, dirs: string[], fn: () => T | Promise<T>): Promise<T> {
  for (const dir of dirs) fs.chmodSync(path.join(root, dir), 0o000);
  try {
    return await fn();
  } finally {
    for (const dir of dirs) fs.chmodSync(path.join(root, dir), 0o755);
  }
}

const relDirs = (root: string, dirs: string[]) => dirs.map((d) => path.relative(root, d) || '.');

describe('in a git repository', () => {
  const IGNORED = ['.claude/worktrees', 'scratch'];
  let root: string;

  beforeAll(() => {
    root = projectWithCopies([...IGNORED.map((d) => `${d}/copy`), 'dist']);
    initRepo(root);
    writeFile(root, '.git/info/exclude', '.claude/worktrees/\n');
    writeFile(root, '.gitignore', 'scratch/\n');
  });

  afterAll(() => cleanup(root));

  it('reads tsconfigs and python roots only from files git lists, outside IGNORE', () => {
    const ctx = loadResolverContext(root);
    expect(relDirs(root, ctx.tsconfigs.map((c) => c.dir))).toEqual(['.']);
    expect(relDirs(root, ctx.pythonRoots)).toEqual(['api', '.']);
  });

  it('scans no file git ignores', async () => {
    const { symbols } = await analyzeProject(root);
    const files = [...new Set(symbols.map((s) => s.file))].sort();
    expect(files).toEqual(['api/pyproject.toml', 'src/helper.ts']);
  });

  it.skipIf(!CAN_LOCK)('never walks into an ignored directory', async () => {
    await withLocked(root, IGNORED, async () => {
      expect(relDirs(root, loadResolverContext(root).pythonRoots)).toEqual(['api', '.']);
      const { symbols } = await analyzeProject(root);
      expect(symbols.some((s) => s.file === 'src/helper.ts')).toBe(true);
    });
  });
});

describe('outside a git repository', () => {
  let root: string;

  beforeAll(() => {
    root = projectWithCopies(['.claude/worktrees/copy', 'dist']);
    writeFile(root, 'pnpm-workspace.yaml', 'packages:\n  - "packages/**"\n');
    writeFile(root, 'packages/ui/package.json', JSON.stringify({ name: '@acme/ui' }));
    writeFile(root, 'packages/ui/dist/package.json', JSON.stringify({ name: '@acme/ui-dist' }));
    writeFile(root, 'packages/ui/.cache/pkg/package.json', JSON.stringify({ name: '@acme/cache' }));
  });

  afterAll(() => cleanup(root));

  it('skips IGNORE and hidden directories', () => {
    const ctx = loadResolverContext(root);
    expect(relDirs(root, ctx.tsconfigs.map((c) => c.dir))).toEqual(['.']);
    expect(relDirs(root, ctx.pythonRoots)).toEqual(['api', '.']);
    expect(ctx.packages.map((p) => p.name)).toEqual(['@acme/ui']);
  });

  // A hidden directory itself is listed, as an ignored one is; nothing below it is
  it.skipIf(!CAN_LOCK)('never walks below a hidden directory', async () => {
    await withLocked(root, ['.claude/worktrees', 'packages/ui/.cache/pkg'], () => {
      expect(relDirs(root, loadResolverContext(root).pythonRoots)).toEqual(['api', '.']);
    });
  });
});
