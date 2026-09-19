import { describe, expect, it } from 'vitest';
import { diffSnapshots } from '../src/diff';
import { makeComponent, makeSnapshot } from './helpers';

const a = makeComponent({ id: 'src/A.tsx#A', props: ['x'] });
const b = makeComponent({ id: 'src/B.tsx#B', hooks: [{ name: 'useState', detail: 's' }] });

describe('diffSnapshots', () => {
  it('detects added and removed components', () => {
    const d = diffSnapshots(makeSnapshot([a]), makeSnapshot([a, b]));
    expect(d.added).toEqual(['src/B.tsx#B']);
    expect(d.removed).toEqual([]);
    const back = diffSnapshots(makeSnapshot([a, b]), makeSnapshot([a]));
    expect(back.removed).toEqual(['src/B.tsx#B']);
  });

  it('flags prop changes as changed', () => {
    const a2 = makeComponent({ id: 'src/A.tsx#A', props: ['x', 'y'] });
    const d = diffSnapshots(makeSnapshot([a]), makeSnapshot([a2]));
    expect(d.changed).toEqual(['src/A.tsx#A']);
    expect(d.added).toEqual([]);
  });

  it('flags hook changes as changed', () => {
    const b2 = makeComponent({ id: 'src/B.tsx#B', hooks: [{ name: 'useState', detail: 't' }] });
    const d = diffSnapshots(makeSnapshot([b]), makeSnapshot([b2]));
    expect(d.changed).toEqual(['src/B.tsx#B']);
  });

  it('ignores render-order differences', () => {
    const c1 = makeComponent({ id: 'src/C.tsx#C', renders: [{ name: 'A' }, { name: 'B' }] });
    const c2 = makeComponent({ id: 'src/C.tsx#C', renders: [{ name: 'B' }, { name: 'A' }] });
    const d = diffSnapshots(makeSnapshot([c1]), makeSnapshot([c2]));
    expect(d.changed).toEqual([]);
  });

  it('reports identical snapshots as unchanged', () => {
    const d = diffSnapshots(makeSnapshot([a, b]), makeSnapshot([a, b]));
    expect(d).toEqual({ added: [], removed: [], changed: [] });
  });
});
