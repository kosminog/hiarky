import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backfillProject } from '../src/backfill';
import { installHook, uninstallHook } from '../src/hook';
import { readGitInfo } from '../src/project';
import { loadSnapshots, snapProject } from '../src/snap';
import {
  APP_TSX,
  BUTTON_TSX,
  cleanup,
  commitAll,
  git,
  initRepo,
  makeProject,
  snapshotFiles,
  writeFile,
} from './helpers';

const DIST_CLI = path.resolve('dist/index.js');

describe('readGitInfo', () => {
  it('returns null outside a repo or before the first commit', () => {
    const root = makeProject();
    try {
      expect(readGitInfo(root)).toBeNull();
      initRepo(root);
      expect(readGitInfo(root)).toBeNull(); // no commits yet
    } finally {
      cleanup(root);
    }
  });

  it('reports commit, branch, and dirty state', () => {
    const root = makeProject();
    try {
      initRepo(root);
      const sha = commitAll(root, 'init', '2026-01-01T00:00:00Z');
      expect(readGitInfo(root)).toEqual({ commit: sha, branch: 'main', dirty: false });
      writeFile(root, 'extra.txt', 'x');
      expect(readGitInfo(root)?.dirty).toBe(true);
    } finally {
      cleanup(root);
    }
  });
});

describe('git hooks', () => {
  let root: string;
  let hookFile: string;

  beforeAll(() => {
    root = makeProject({ 'src/App.tsx': APP_TSX, 'src/Button.tsx': BUTTON_TSX });
    initRepo(root);
    commitAll(root, 'init', '2026-01-01T00:00:00Z');
    hookFile = path.join(root, '.git', 'hooks', 'post-commit');
  });
  afterAll(() => cleanup(root));

  it('refuses outside a git repository', () => {
    const bare = makeProject();
    try {
      expect(() => installHook(bare)).toThrow('not inside a git repository');
    } finally {
      cleanup(bare);
    }
  });

  it('installs an executable, marker-tagged hook pointing at the project', () => {
    expect(installHook(root)).toBe(hookFile);
    const content = fs.readFileSync(hookFile, 'utf8');
    expect(content).toContain('# hiarky-hook');
    expect(content).toContain(`cd "${root}"`);
    expect(fs.statSync(hookFile).mode & 0o111).toBeTruthy();
  });

  it('reinstalls over its own hook without force', () => {
    expect(() => installHook(root)).not.toThrow();
  });

  it.skipIf(!fs.existsSync(DIST_CLI))('fires on a real git commit', () => {
    // Shim `hiarky` onto PATH so the hook resolves to this checkout's build
    const binDir = path.join(root, '.test-bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, 'hiarky'),
      `#!/bin/sh\nexec node "${DIST_CLI}" "$@"\n`,
      { mode: 0o755 }
    );
    expect(snapshotFiles(root)).toHaveLength(0);
    writeFile(root, 'src/New.tsx', 'export const New = () => <p />;\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'add component'], {
      PATH: `${binDir}:${process.env.PATH}`,
    });
    expect(snapshotFiles(root)).toHaveLength(1);
    const [snap] = loadSnapshots(root);
    expect(snap.git?.dirty).toBe(false);
    expect(snap.symbols.some((c) => c.name === 'New')).toBe(true);
  });

  it('uninstalls its own hook', () => {
    expect(uninstallHook(root)).toBe(true);
    expect(fs.existsSync(hookFile)).toBe(false);
    expect(uninstallHook(root)).toBe(false); // idempotent
  });

  it('refuses to overwrite or remove a foreign hook, unless forced', () => {
    fs.writeFileSync(hookFile, '#!/bin/sh\necho custom\n', { mode: 0o755 });
    expect(() => installHook(root)).toThrow('already exists');
    expect(() => uninstallHook(root)).toThrow('not installed by hiarky');
    expect(() => installHook(root, { force: true })).not.toThrow();
    expect(fs.readFileSync(hookFile, 'utf8')).toContain('# hiarky-hook');
    uninstallHook(root);
  });
});

describe('backfill', () => {
  let root: string;
  const dates = [
    '2026-01-01T00:00:00Z',
    '2026-01-02T00:00:00Z',
    '2026-01-03T00:00:00Z',
    '2026-01-04T00:00:00Z',
  ];

  beforeAll(() => {
    // c1: repo predates the project (no package.json)
    root = makeProject({ 'README.md': 'hello' });
    fs.rmSync(path.join(root, 'package.json'));
    initRepo(root);
    commitAll(root, 'c1: no project yet', dates[0]);
    // c2: project appears with two components
    writeFile(root, 'package.json', JSON.stringify({ name: 'scratch', private: true }));
    writeFile(root, 'src/App.tsx', APP_TSX);
    writeFile(root, 'src/Button.tsx', BUTTON_TSX);
    commitAll(root, 'c2: add app', dates[1]);
    // c3: unrelated change, component tree identical
    writeFile(root, 'README.md', 'hello world');
    commitAll(root, 'c3: docs only', dates[2]);
    // c4: component change
    writeFile(root, 'src/Extra.tsx', 'export const Extra = () => <p />;\n');
    commitAll(root, 'c4: add Extra', dates[3]);
  });
  afterAll(() => cleanup(root));

  it('snapshots each distinct tree, skipping pre-project and unchanged commits', async () => {
    const result = await backfillProject(root, { max: 100 });
    expect(result).toEqual({
      written: 2,
      skippedExisting: 0,
      skippedSame: 1,
      skippedMissing: 1,
    });
  });

  it('dates snapshots by commit time and records clean git info', () => {
    const snaps = loadSnapshots(root);
    expect(snaps.map((s) => s.timestamp)).toEqual([
      '2026-01-02T00:00:00.000Z',
      '2026-01-04T00:00:00.000Z',
    ]);
    expect(snaps.map((s) => s.stats.components)).toEqual([2, 3]);
    expect(snaps.every((s) => s.git?.branch === 'main' && s.git.dirty === false)).toBe(true);
  });

  it('is idempotent on a second run', async () => {
    const result = await backfillProject(root, { max: 100 });
    expect(result).toEqual({
      written: 0,
      skippedExisting: 2,
      skippedSame: 1,
      skippedMissing: 1,
    });
    expect(snapshotFiles(root)).toHaveLength(2);
  });

  it('respects --max by taking the most recent commits', async () => {
    const fresh = makeProject({ 'src/App.tsx': APP_TSX, 'src/Button.tsx': BUTTON_TSX });
    try {
      initRepo(fresh);
      commitAll(fresh, 'first', dates[0]);
      writeFile(fresh, 'src/Extra.tsx', 'export const Extra = () => <p />;\n');
      commitAll(fresh, 'second', dates[1]);
      const result = await backfillProject(fresh, { max: 1 });
      expect(result.written).toBe(1);
      expect(loadSnapshots(fresh)[0].stats.components).toBe(3); // newest commit only
    } finally {
      cleanup(fresh);
    }
  });

  it('interleaves with normal snapshots after new work', async () => {
    writeFile(root, 'src/Later.tsx', 'export const Later = () => <p />;\n');
    await snapProject(root, { quiet: true });
    const snaps = loadSnapshots(root);
    expect(snaps).toHaveLength(3);
    expect(snaps[2].stats.components).toBe(4);
    expect(snaps[2].git?.dirty).toBe(true);
  });

  it('throws for a project outside any git repository', async () => {
    const bare = makeProject();
    try {
      await expect(backfillProject(bare, { max: 10 })).rejects.toThrow('not a git repository');
    } finally {
      cleanup(bare);
    }
  });
});
