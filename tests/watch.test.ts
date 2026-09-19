import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSnapshots } from '../src/snap';
import { watchProject, WatchHandle } from '../src/watch';
import {
  APP_TSX,
  BUTTON_TSX,
  cleanup,
  makeProject,
  snapshotFiles,
  waitFor,
  writeFile,
} from './helpers';

describe('watch mode', () => {
  let root: string;
  let handle: WatchHandle;
  // One entry per snapshot attempt: true = snapshot written, false = deduped
  const events: boolean[] = [];

  beforeAll(async () => {
    root = makeProject({ 'src/App.tsx': APP_TSX, 'src/Button.tsx': BUTTON_TSX });
    handle = await watchProject(root, {
      debounce: 100,
      quiet: true,
      onSnapshot: (written) => events.push(written),
    });
  });

  afterAll(async () => {
    await handle.close();
    cleanup(root);
  });

  it('takes a baseline snapshot on start', () => {
    expect(events).toEqual([true]);
    expect(snapshotFiles(root)).toHaveLength(1);
  });

  it('snapshots after a component change', async () => {
    writeFile(
      root,
      'src/Button.tsx',
      BUTTON_TSX.replace('{ label }: { label: string }', '{ label, kind }: { label: string; kind: string }')
    );
    await waitFor(() => events.length === 2);
    expect(events[1]).toBe(true);
    expect(snapshotFiles(root)).toHaveLength(2);
  });

  it('dedupes cosmetic-only changes', async () => {
    writeFile(root, 'src/App.tsx', '// cosmetic comment\n' + APP_TSX);
    await waitFor(() => events.length === 3);
    expect(events[2]).toBe(false);
    expect(snapshotFiles(root)).toHaveLength(2);
  });

  it('snapshots on file deletion', async () => {
    fs.rmSync(path.join(root, 'src', 'Button.tsx'));
    await waitFor(() => events.length === 4);
    expect(events[3]).toBe(true);
    const snaps = loadSnapshots(root);
    expect(snaps[snaps.length - 1].components.map((c) => c.name)).toEqual(['App']);
  });

  it('stops reacting after close', async () => {
    await handle.close();
    writeFile(root, 'src/Another.tsx', 'export const Another = () => <p />;\n');
    await new Promise((r) => setTimeout(r, 400)); // > debounce; nothing should fire
    expect(events).toHaveLength(4);
    expect(snapshotFiles(root)).toHaveLength(3);
  });
});
