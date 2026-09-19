import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listRows, pruneProject } from '../src/list';
import { loadSnapshots, snapProject } from '../src/snap';
import { viewProject } from '../src/view';
import {
  APP_TSX,
  BUTTON_TSX,
  cleanup,
  makeProject,
  snapshotFiles,
  writeFile,
} from './helpers';

describe('snap → list → prune lifecycle', () => {
  let root: string;

  beforeAll(() => {
    root = makeProject({ 'src/App.tsx': APP_TSX, 'src/Button.tsx': BUTTON_TSX });
  });
  afterAll(() => cleanup(root));

  it('writes a first snapshot', async () => {
    expect(await snapProject(root, { quiet: true })).toBe(true);
    expect(snapshotFiles(root)).toHaveLength(1);
    const [snap] = loadSnapshots(root);
    expect(snap.stats.components).toBe(2);
    expect(snap.git).toBeNull();
    expect(snap.roots).toEqual(['src/App.tsx#App']);
  });

  it('skips an identical snapshot', async () => {
    expect(await snapProject(root, { quiet: true })).toBe(false);
    expect(snapshotFiles(root)).toHaveLength(1);
  });

  it('snapshots anyway with force', async () => {
    expect(await snapProject(root, { quiet: true, force: true })).toBe(true);
    expect(snapshotFiles(root)).toHaveLength(2);
  });

  it('writes a new snapshot after a component change', async () => {
    writeFile(
      root,
      'src/Button.tsx',
      `export function Button({ label, disabled }: { label: string; disabled?: boolean }) {
  return <button disabled={disabled}>{label}</button>;
}
`
    );
    expect(await snapProject(root, { quiet: true })).toBe(true);
    expect(snapshotFiles(root)).toHaveLength(3);
  });

  it('lists rows with change badges', () => {
    const rows = listRows(root);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.idx)).toEqual(['1', '2', '3']);
    expect(rows.map((r) => r.commit)).toEqual(['-', '-', '-']);
    expect(rows[1].changes).toBe(''); // forced duplicate: no changes
    expect(rows[2].changes).toBe('~1'); // Button gained a prop
  });

  it('generates a viewer embedding the snapshots', () => {
    viewProject(root, { open: false });
    const html = fs.readFileSync(path.join(root, '.hiarky', 'view.html'), 'utf8');
    expect(html).toContain('Button');
    expect(html).toContain('src/App.tsx#App');
  });

  it('prunes with dry-run leaving files intact', () => {
    const result = pruneProject(root, { keep: 2, dryRun: true });
    expect(result.deleted).toHaveLength(1);
    expect(snapshotFiles(root)).toHaveLength(3);
  });

  it('prunes for real, keeping the newest N', () => {
    const result = pruneProject(root, { keep: 2 });
    expect(result).toMatchObject({ kept: 2 });
    expect(snapshotFiles(root)).toHaveLength(2);
    // the oldest snapshot is the one that went
    expect(loadSnapshots(root)[0].stats.components).toBe(2);
  });

  it('rejects a non-positive keep', () => {
    expect(() => pruneProject(root, { keep: 0 })).toThrow('--keep');
  });
});

describe('edge cases', () => {
  it('snapshots a project with no components', async () => {
    const root = makeProject();
    try {
      expect(await snapProject(root, { quiet: true })).toBe(true);
      const [snap] = loadSnapshots(root);
      expect(snap.stats.components).toBe(0);
      expect(snap.roots).toEqual([]);
    } finally {
      cleanup(root);
    }
  });

  it('viewProject throws when there are no snapshots', () => {
    const root = makeProject();
    try {
      expect(() => viewProject(root, { open: false })).toThrow('no snapshots');
    } finally {
      cleanup(root);
    }
  });

  it('records parse failures in the snapshot instead of aborting', async () => {
    const root = makeProject({
      'src/Good.tsx': BUTTON_TSX.replace('Button', 'Good'),
      'src/Bad.tsx': 'export function Bad() { const x = ; return <div />; }\n',
    });
    try {
      await snapProject(root, { quiet: true });
      const [snap] = loadSnapshots(root);
      expect(snap.errors?.some((e) => e.file === 'src/Bad.tsx')).toBe(true);
      expect(snap.components.some((c) => c.name === 'Good')).toBe(true);
    } finally {
      cleanup(root);
    }
  });
});
