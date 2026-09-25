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

describe('ranking declarative and framework symbols', () => {
  const symbolOf = (over: Parameters<typeof makeSymbol>[0]) => makeSymbol(over);

  it('ranks a new migration above an ordinary new function', () => {
    const prev = makeSnapshot([]);
    const next = makeSnapshot([
      symbolOf({ id: 'prisma/migrations/x/migration.sql#x', kind: 'migration', export: 'none' }),
      symbolOf({ id: 'src/util.ts#helper', kind: 'function' }),
    ]);
    const { changes } = reviewSnapshots(prev, next);
    expect(changes[0].id).toBe('prisma/migrations/x/migration.sql#x');
    expect(changes[0].reasons).toContain('database migration');
    expect(changes[0].impact).toBeGreaterThan(changes[1].impact);
  });

  it('treats a model as public even though nothing exports it', () => {
    const prev = makeSnapshot([
      symbolOf({ id: 's.prisma#Company', kind: 'model', export: 'none', members: ['id: String'] }),
    ]);
    const next = makeSnapshot([
      symbolOf({
        id: 's.prisma#Company',
        kind: 'model',
        export: 'none',
        members: ['id: String', 'tier: Int'],
      }),
    ]);
    const { changes, surfaceFiles } = reviewSnapshots(prev, next);
    expect(changes[0].reasons).toContain('on the public surface');
    expect(changes[0].reasons).toContain('fields changed');
    expect(surfaceFiles).toEqual(['s.prisma']);
  });

  it('ranks a new environment variable above a dependency bump', () => {
    const prev = makeSnapshot([
      symbolOf({ id: '.env.example#env', kind: 'config', role: ['env'], members: ['A'] }),
      symbolOf({ id: 'package.json#dependencies', kind: 'config', members: ['react@^18.0.0'] }),
    ]);
    const next = makeSnapshot([
      symbolOf({ id: '.env.example#env', kind: 'config', role: ['env'], members: ['A', 'B'] }),
      symbolOf({ id: 'package.json#dependencies', kind: 'config', members: ['react@^19.0.0'] }),
    ]);
    const { changes } = reviewSnapshots(prev, next);
    expect(changes[0].id).toBe('.env.example#env');
    expect(changes[0].impact).toBeGreaterThan(changes[1].impact);
  });

  it('treats a changed route path as a break', () => {
    const prev = makeSnapshot([
      symbolOf({ id: 'src/app/old/page.tsx#P', kind: 'route', route: '/old', bodyHash: 'same' }),
    ]);
    const next = makeSnapshot([
      symbolOf({ id: 'src/app/new/page.tsx#P', kind: 'route', route: '/new', bodyHash: 'same' }),
    ]);
    const { changes } = reviewSnapshots(prev, next);
    // The body is identical, so it reads as a move that changed its URL
    expect(changes[0].kind).toBe('moved');
    expect(changes[0].deltas).toContainEqual({ field: 'route', from: '/old', to: '/new' });
  });

  it('shows what a new procedure accepts', () => {
    const next = makeSnapshot([
      symbolOf({ id: 'src/r.ts#r.setTier', kind: 'procedure', members: ['ids', 'tier'] }),
    ]);
    const { changes } = reviewSnapshots(makeSnapshot([]), next);
    expect(changes[0].members).toEqual(['ids', 'tier']);
    expect(changes[0].reasons).toContain('API procedure');
  });
});

describe('lines', () => {
  it('carries the new line of a changed, added, or moved symbol, and none for a removal', () => {
    const prev = makeSnapshot([
      makeSymbol({ id: 'src/a.ts#f', signature: '()', bodyHash: 'f1', line: 3 }),
      makeSymbol({ id: 'src/a.ts#gone', bodyHash: 'g1', line: 20 }),
      makeSymbol({ id: 'src/old.ts#same', bodyHash: 's1', line: 8 }),
    ]);
    const next = makeSnapshot([
      makeSymbol({ id: 'src/a.ts#f', signature: '(x)', bodyHash: 'f2', line: 5 }),
      makeSymbol({ id: 'src/a.ts#fresh', bodyHash: 'n1', line: 30 }),
      makeSymbol({ id: 'src/new.ts#same', bodyHash: 's1', line: 12 }),
    ]);
    const { changes } = reviewSnapshots(prev, next);
    expect(find(changes, 'src/a.ts#f').line).toBe(5);
    expect(find(changes, 'src/a.ts#fresh').line).toBe(30);
    expect(find(changes, 'src/new.ts#same').line).toBe(12);
    expect(find(changes, 'src/a.ts#gone').line).toBeUndefined();
  });
});

describe('dependency graph', () => {
  // Untouched code that reaches the changed function: present on both sides
  const bystanders = [
    makeSymbol({
      id: 'src/admin.ts#list',
      edges: [{ kind: 'calls', name: 'fetchUser', id: 'src/api.ts#fetchUser' }],
    }),
    makeSymbol({
      id: 'src/admin.ts#show',
      edges: [{ kind: 'references', name: 'fetchUser', id: 'src/api.ts#fetchUser' }],
    }),
    makeSymbol({
      id: 'tests/api.test.ts#api',
      kind: 'test',
      role: ['test'],
      export: 'none',
      edges: [{ kind: 'calls', name: 'fetchUser', id: 'src/api.ts#fetchUser' }],
    }),
  ];
  const prev = makeSnapshot([
    makeSymbol({ id: 'src/api.ts#fetchUser', signature: '(id: string)', bodyHash: 'a1' }),
    makeSymbol({ id: 'src/api.ts#gone', bodyHash: 'g1' }),
    makeSymbol({
      id: 'src/page.ts#Page',
      bodyHash: 'p1',
      edges: [{ kind: 'calls', name: 'fetchUser', id: 'src/api.ts#fetchUser' }],
    }),
    ...bystanders,
  ]);
  const next = makeSnapshot([
    makeSymbol({ id: 'src/api.ts#fetchUser', signature: '(id: string, opts: {})', bodyHash: 'a2' }),
    makeSymbol({
      id: 'src/page.ts#Page',
      bodyHash: 'p2',
      edges: [{ kind: 'calls', name: 'fetchUser', id: 'src/api.ts#fetchUser' }],
    }),
    ...bystanders,
  ]);
  const { graph, changes } = reviewSnapshots(prev, next);

  it('records edges between changed symbols', () => {
    expect(graph.edges).toEqual([
      { from: 'src/page.ts#Page', to: 'src/api.ts#fetchUser', kind: 'calls' },
    ]);
  });

  it('groups unchanged dependents by file and counts their symbols', () => {
    expect(graph.dependents).toContainEqual({
      file: 'src/admin.ts',
      symbols: 2,
      targets: ['src/api.ts#fetchUser'],
      test: false,
    });
  });

  it('marks a file of test code as such', () => {
    expect(graph.dependents).toContainEqual({
      file: 'tests/api.test.ts',
      symbols: 1,
      targets: ['src/api.ts#fetchUser'],
      test: true,
    });
  });

  it('gives a removed symbol no dependents', () => {
    expect(changes.some((c) => c.id === 'src/api.ts#gone' && c.kind === 'removed')).toBe(true);
    expect(graph.dependents.flatMap((d) => d.targets)).not.toContain('src/api.ts#gone');
  });

  it('does not count a changed symbol as a bystander of another', () => {
    expect(graph.dependents.map((d) => d.file)).not.toContain('src/page.ts');
  });
});

describe('render tree', () => {
  const page = makeComponent({
    id: 'src/app/page.tsx#Page',
    kind: 'route',
    route: '/todos',
    bodyHash: 'p',
    renders: [{ name: 'List', id: 'src/List.tsx#List' }],
  });
  const list = (hash: string) =>
    makeComponent({
      id: 'src/List.tsx#List',
      bodyHash: hash,
      renders: [{ name: 'Item', id: 'src/Item.tsx#Item' }],
    });
  const item = (hash: string, extra: Array<{ name: string; id: string }> = []) =>
    makeComponent({ id: 'src/Item.tsx#Item', bodyHash: hash, renders: extra });
  const badge = makeComponent({ id: 'src/Badge.tsx#Badge', bodyHash: 'b' });
  const aside = makeComponent({ id: 'src/Aside.tsx#Aside', bodyHash: 'a' });

  const prev = makeSnapshot([page, list('l1'), item('i1'), aside]);
  const next = makeSnapshot([
    page,
    list('l1'),
    item('i2', [{ name: 'Badge', id: 'src/Badge.tsx#Badge' }]),
    badge,
    aside,
  ]);
  const { renderTree } = reviewSnapshots(prev, next).graph;
  const names = () => renderTree.nodes.map((n) => `${n.name}${n.change ? ':' + n.change : ''}`);

  it('keeps every changed component and the path up to the page that renders it', () => {
    expect(names().sort()).toEqual(['Badge:added', 'Item:changed', 'List', 'Page'].sort());
    expect(renderTree.edges).toContainEqual({ from: 'src/List.tsx#List', to: 'src/Item.tsx#Item' });
    expect(renderTree.edges).toContainEqual({ from: 'src/app/page.tsx#Page', to: 'src/List.tsx#List' });
    expect(renderTree.edges).toContainEqual({ from: 'src/Item.tsx#Item', to: 'src/Badge.tsx#Badge' });
  });

  it('carries the URL of a page on the path', () => {
    expect(renderTree.nodes.find((n) => n.name === 'Page')?.route).toBe('/todos');
  });

  it('leaves components off the path alone', () => {
    expect(names()).not.toContain('Aside');
  });

  it('survives a render cycle', () => {
    const a = (hash: string) =>
      makeComponent({ id: 'src/A.tsx#A', bodyHash: hash, renders: [{ name: 'B', id: 'src/B.tsx#B' }] });
    const b = makeComponent({ id: 'src/B.tsx#B', bodyHash: 'b', renders: [{ name: 'A', id: 'src/A.tsx#A' }] });
    const tree = reviewSnapshots(makeSnapshot([a('1'), b]), makeSnapshot([a('2'), b])).graph.renderTree;
    expect(tree.nodes.map((n) => n.name).sort()).toEqual(['A', 'B']);
  });

  it('is empty when nothing renderable changed', () => {
    const tree = reviewSnapshots(
      makeSnapshot([makeSymbol({ id: 'src/x.ts#f', bodyHash: '1' })]),
      makeSnapshot([makeSymbol({ id: 'src/x.ts#f', bodyHash: '2' })])
    ).graph.renderTree;
    expect(tree).toEqual({ nodes: [], edges: [] });
  });
});
