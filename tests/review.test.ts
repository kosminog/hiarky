import { describe, expect, it } from 'vitest';
import { reviewSnapshots, symbolDeltas } from '../src/review';
import { makeComponent, makeSnapshot, makeSymbol } from './helpers';

const find = (changes: ReturnType<typeof reviewSnapshots>['changes'], id: string) => {
  const c = changes.find((x) => x.id === id);
  if (!c) throw new Error(`no change for ${id} in [${changes.map((x) => x.id)}]`);
  return c;
};

describe('symbolDeltas', () => {
  const base = makeSymbol({
    id: 'src/a.ts#run',
    signature: '(a: string)',
    members: ['x'],
    bodyHash: 'aaa',
  });

  it('reports member additions and removals separately', () => {
    const next = makeSymbol({ ...base, members: ['x', 'y'], bodyHash: 'bbb' });
    expect(symbolDeltas(base, next)).toEqual([{ field: 'members', added: ['y'] }]);
  });

  it('reports signature changes with both sides', () => {
    const next = makeSymbol({ ...base, signature: '(a: string, b: number)', bodyHash: 'bbb' });
    expect(symbolDeltas(base, next)).toEqual([
      { field: 'signature', from: '(a: string)', to: '(a: string, b: number)' },
    ]);
  });

  it('reports export changes', () => {
    const next = makeSymbol({ ...base, export: 'none' });
    expect(symbolDeltas(base, next)).toEqual([{ field: 'export', from: 'named', to: 'none' }]);
  });

  it('separates edge kinds', () => {
    const before = makeSymbol({ id: 'src/a.ts#C', edges: [{ kind: 'calls', name: 'old' }] });
    const after = makeSymbol({
      id: 'src/a.ts#C',
      edges: [
        { kind: 'calls', name: 'fresh' },
        { kind: 'renders', name: 'Button' },
      ],
    });
    expect(symbolDeltas(before, after)).toEqual([
      { field: 'renders', added: ['Button'] },
      { field: 'calls', added: ['fresh'], removed: ['old'] },
    ]);
  });

  it('falls back to a body-only delta when nothing else moved', () => {
    const next = makeSymbol({ ...base, bodyHash: 'bbb' });
    expect(symbolDeltas(base, next)).toEqual([{ field: 'body' }]);
  });

  it('does not add a body delta when a real field explains the change', () => {
    const next = makeSymbol({ ...base, members: ['x', 'y'], bodyHash: 'bbb' });
    expect(symbolDeltas(base, next).map((d) => d.field)).toEqual(['members']);
  });

  it('reports nothing for an identical symbol', () => {
    expect(symbolDeltas(base, makeSymbol({ ...base }))).toEqual([]);
  });
});

describe('impact ranking', () => {
  it('puts an exported removal above an internal signature change', () => {
    const prev = makeSnapshot([
      makeSymbol({ id: 'src/a.ts#gone', export: 'named' }),
      makeSymbol({ id: 'src/b.ts#quiet', export: 'none', signature: '()' }),
    ]);
    const next = makeSnapshot([
      makeSymbol({ id: 'src/b.ts#quiet', export: 'none', signature: '(x: number)' }),
    ]);
    const { changes } = reviewSnapshots(prev, next);
    expect(changes.map((c) => c.id)).toEqual(['src/a.ts#gone', 'src/b.ts#quiet']);
    expect(changes[0].impact).toBeGreaterThan(changes[1].impact);
    expect(changes[0].reasons).toContain('exported symbol removed');
  });

  it('weights the same edit higher when the symbol is exported', () => {
    const before = (id: string) => makeSymbol({ id, members: ['a'] });
    const after = (id: string) => makeSymbol({ id, members: ['a', 'b'] });
    const pub = reviewSnapshots(makeSnapshot([before('x.ts#p')]), makeSnapshot([after('x.ts#p')]));
    const priv = reviewSnapshots(
      makeSnapshot([makeSymbol({ ...before('x.ts#p'), export: 'none' })]),
      makeSnapshot([makeSymbol({ ...after('x.ts#p'), export: 'none' })])
    );
    expect(pub.changes[0].impact).toBeGreaterThan(priv.changes[0].impact);
    expect(pub.changes[0].reasons).toContain('on the public surface');
  });

  it('ranks a body-only change at the bottom', () => {
    const prev = makeSnapshot([
      makeSymbol({ id: 'src/a.ts#body', bodyHash: 'a' }),
      makeSymbol({ id: 'src/b.ts#props', members: ['x'] }),
    ]);
    const next = makeSnapshot([
      makeSymbol({ id: 'src/a.ts#body', bodyHash: 'b' }),
      makeSymbol({ id: 'src/b.ts#props', members: ['x', 'y'] }),
    ]);
    const { changes } = reviewSnapshots(prev, next);
    expect(changes[changes.length - 1].id).toBe('src/a.ts#body');
    expect(changes[changes.length - 1].reasons).toContain('body only');
  });
});

describe('move detection', () => {
  it('pairs a removal and an addition that share a body hash', () => {
    const prev = makeSnapshot([makeSymbol({ id: 'src/old/a.ts#helper', bodyHash: 'h1' })]);
    const next = makeSnapshot([makeSymbol({ id: 'src/new/a.ts#helper', bodyHash: 'h1' })]);
    const { changes, stats } = reviewSnapshots(prev, next);
    expect(stats).toMatchObject({ moved: 1, added: 0, removed: 0 });
    expect(changes[0].previousId).toBe('src/old/a.ts#helper');
    expect(changes[0].reasons).toContain('moved or renamed, body identical');
  });

  it('detects a rename within one file', () => {
    const prev = makeSnapshot([makeSymbol({ id: 'src/a.ts#oldName', bodyHash: 'h1' })]);
    const next = makeSnapshot([makeSymbol({ id: 'src/a.ts#newName', bodyHash: 'h1' })]);
    const { changes } = reviewSnapshots(prev, next);
    expect(changes[0]).toMatchObject({ kind: 'moved', previousId: 'src/a.ts#oldName' });
  });

  it('prefers the candidate that kept its name', () => {
    const prev = makeSnapshot([makeSymbol({ id: 'src/a.ts#keep', bodyHash: 'h1' })]);
    const next = makeSnapshot([
      makeSymbol({ id: 'src/z.ts#other', bodyHash: 'h1' }),
      makeSymbol({ id: 'src/b.ts#keep', bodyHash: 'h1' }),
    ]);
    const { changes } = reviewSnapshots(prev, next);
    expect(find(changes, 'src/b.ts#keep').kind).toBe('moved');
    expect(find(changes, 'src/z.ts#other').kind).toBe('added');
  });

  it('leaves an ambiguous pair as an add plus a remove', () => {
    const prev = makeSnapshot([makeSymbol({ id: 'src/a.ts#one', bodyHash: 'same' })]);
    const next = makeSnapshot([
      makeSymbol({ id: 'src/b.ts#two', bodyHash: 'same' }),
      makeSymbol({ id: 'src/c.ts#three', bodyHash: 'same' }),
    ]);
    const { stats } = reviewSnapshots(prev, next);
    expect(stats).toMatchObject({ moved: 0, added: 2, removed: 1 });
  });

  it('never pairs symbols from upgraded snapshots with no body hash', () => {
    const prev = makeSnapshot([makeSymbol({ id: 'src/a.ts#x', bodyHash: '' })]);
    const next = makeSnapshot([makeSymbol({ id: 'src/b.ts#x', bodyHash: '' })]);
    expect(reviewSnapshots(prev, next).stats).toMatchObject({ moved: 0, added: 1, removed: 1 });
  });
});

describe('review scope', () => {
  it('restricts changes to the given files', () => {
    const prev = makeSnapshot([
      makeSymbol({ id: 'src/a.ts#a', members: [] }),
      makeSymbol({ id: 'src/b.ts#b', members: [] }),
    ]);
    const next = makeSnapshot([
      makeSymbol({ id: 'src/a.ts#a', members: ['x'] }),
      makeSymbol({ id: 'src/b.ts#b', members: ['y'] }),
    ]);
    const { changes } = reviewSnapshots(prev, next, { files: ['src/a.ts'] });
    expect(changes.map((c) => c.id)).toEqual(['src/a.ts#a']);
  });

  it('reports files whose exported surface changed', () => {
    const prev = makeSnapshot([
      makeSymbol({ id: 'src/api.ts#get', signature: '()' }),
      makeSymbol({ id: 'src/util.ts#hidden', export: 'none', bodyHash: 'a' }),
    ]);
    const next = makeSnapshot([
      makeSymbol({ id: 'src/api.ts#get', signature: '(id: string)' }),
      makeSymbol({ id: 'src/util.ts#hidden', export: 'none', bodyHash: 'b' }),
    ]);
    expect(reviewSnapshots(prev, next).surfaceFiles).toEqual(['src/api.ts']);
  });

  it('flags files that had no symbols before as new', () => {
    const prev = makeSnapshot([makeComponent({ id: 'src/App.tsx#App' })]);
    const next = makeSnapshot([
      makeComponent({ id: 'src/App.tsx#App' }),
      makeSymbol({ id: 'src/fresh.ts#a' }),
      makeSymbol({ id: 'src/fresh.ts#b' }),
    ]);
    expect(reviewSnapshots(prev, next).newFiles).toEqual(['src/fresh.ts']);
  });

  it('does not call a file new when it merely gained a symbol', () => {
    const prev = makeSnapshot([makeSymbol({ id: 'src/a.ts#one' })]);
    const next = makeSnapshot([
      makeSymbol({ id: 'src/a.ts#one' }),
      makeSymbol({ id: 'src/a.ts#two' }),
    ]);
    expect(reviewSnapshots(prev, next).newFiles).toEqual([]);
  });
});
