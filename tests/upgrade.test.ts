import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as yaml from 'js-yaml';
import { diffSnapshots } from '../src/diff';
import { listRows } from '../src/list';
import { loadSnapshots, snapProject } from '../src/snap';
import { edgesOf, SNAPSHOT_VERSION } from '../src/types';
import { APP_TSX, BUTTON_TSX, cleanup, makeProject } from './helpers';

/** A snapshot in the pre-symbol (hiarky: 1) format. */
const LEGACY = {
  hiarky: 1,
  id: 'legacy-0001',
  timestamp: '2026-01-01T00:00:00.000Z',
  project: { root: '/x', name: 'scratch' },
  git: null,
  stats: { files: 2, components: 2 },
  components: [
    {
      id: 'src/App.tsx#App',
      name: 'App',
      file: 'src/App.tsx',
      kind: 'function',
      export: 'default',
      props: [],
      hooks: [{ name: 'useState', detail: 'open' }],
      renders: [{ name: 'Button', id: 'src/Button.tsx#Button' }],
    },
    {
      id: 'src/Button.tsx#Button',
      name: 'Button',
      file: 'src/Button.tsx',
      kind: 'function',
      export: 'named',
      props: ['label'],
      hooks: [],
      renders: [],
    },
  ],
  roots: ['src/App.tsx#App'],
};

let root: string;

beforeAll(() => {
  root = makeProject({ 'src/App.tsx': APP_TSX, 'src/Button.tsx': BUTTON_TSX });
  const dir = path.join(root, '.hiarky', 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '2026-01-01T00-00-00-000Z-legacy-0001.snapshot'),
    yaml.dump(LEGACY)
  );
});

afterAll(() => cleanup(root));

describe('hiarky: 1 snapshots', () => {
  it('load as version 2 with components mapped to symbols', () => {
    const [snap] = loadSnapshots(root);
    expect(snap.hiarky).toBe(SNAPSHOT_VERSION);
    expect(snap.symbols.map((s) => s.id)).toEqual([
      'src/App.tsx#App',
      'src/Button.tsx#Button',
    ]);
    expect(snap.symbols.every((s) => s.kind === 'component')).toBe(true);
    expect(snap.stats).toEqual({ files: 2, symbols: 2, components: 2 });
  });

  it('maps props to members and renders to edges', () => {
    const [snap] = loadSnapshots(root);
    const button = snap.symbols.find((s) => s.id === 'src/Button.tsx#Button')!;
    const app = snap.symbols.find((s) => s.id === 'src/App.tsx#App')!;
    expect(button.members).toEqual(['label']);
    expect(app.hooks).toEqual([{ name: 'useState', detail: 'open' }]);
    expect(edgesOf(app, 'renders')).toEqual([
      { kind: 'renders', name: 'Button', id: 'src/Button.tsx#Button' },
    ]);
  });

  it('diffs against itself as unchanged', () => {
    const [snap] = loadSnapshots(root);
    expect(diffSnapshots(snap, snap)).toEqual({ added: [], removed: [], changed: [] });
  });

  it('keeps working as the previous entry for a new snapshot', async () => {
    expect(await snapProject(root, { quiet: true })).toBe(true);
    const rows = listRows(root);
    expect(rows).toHaveLength(2);
    // App/Button exist in both, so only their newly recorded detail differs
    expect(rows[1].changes).toBe('~2');
    expect(rows[0].components).toBe('2');
  });
});
