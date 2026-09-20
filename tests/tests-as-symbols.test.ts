import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeFile } from '../src/analyze';
import { isTestFile } from '../src/extractors/tests';
import { renderText } from '../src/report';
import { reviewSnapshots } from '../src/review';
import { linkSymbols } from '../src/resolve';
import { analyzeProject } from '../src/snap';
import { SymbolInfo } from '../src/types';
import { cleanup, makeProject, makeSnapshot, makeSymbol, writeFile } from './helpers';

const SUITE = `import { describe, expect, it, beforeEach } from "vitest";
import { formatTier, parseTier } from "./tier";

describe("formatTier", () => {
  beforeEach(() => {});

  it("renders a roman numeral", () => {
    expect(formatTier(1)).toBe("I");
  });

  it("falls back for unknown values", () => {
    expect(formatTier(9)).toBe("?");
  });

  describe("when nested", () => {
    it("still counts", () => {
      expect(parseTier("I")).toBe(1);
    });
  });
});

it("works outside a suite", () => {
  expect(true).toBe(true);
});
`;

const TIER = `export function formatTier(tier: number) {
  return tier === 1 ? "I" : "?";
}

export function parseTier(label: string) {
  return label === "I" ? 1 : 0;
}
`;

let root: string;
const analyze = (rel: string) => analyzeFile(path.join(root, rel), rel);
const byName = (symbols: SymbolInfo[], name: string) => {
  const s = symbols.find((x) => x.name === name);
  if (!s) throw new Error(`no symbol ${name} in [${symbols.map((x) => x.name)}]`);
  return s;
};

beforeAll(() => {
  root = makeProject({ 'src/tier.ts': TIER, 'src/tier.test.ts': SUITE });
});

afterAll(() => cleanup(root));

describe('isTestFile', () => {
  it('recognizes the usual naming conventions', () => {
    expect(isTestFile('src/a.test.ts')).toBe(true);
    expect(isTestFile('src/a.spec.tsx')).toBe(true);
    expect(isTestFile('src/__tests__/a.ts')).toBe(true);
    expect(isTestFile('tests/visual/home.spec.ts')).toBe(true);
  });

  it('leaves ordinary source alone', () => {
    expect(isTestFile('src/latest.ts')).toBe(false);
    expect(isTestFile('src/contest.ts')).toBe(false);
  });
});

describe('test suites as symbols', () => {
  const symbols = () => analyze('src/tier.test.ts').symbols;

  it('records one symbol per top-level suite', () => {
    expect(symbols().filter((s) => s.kind === 'test').map((s) => s.name)).toEqual([
      'formatTier',
      'tier.test',
    ]);
  });

  it('lists cases as members, nesting them by path', () => {
    expect(byName(symbols(), 'formatTier').members).toEqual([
      'renders a roman numeral',
      'falls back for unknown values',
      'when nested > still counts',
    ]);
  });

  it('gathers cases declared outside any suite under the file name', () => {
    expect(byName(symbols(), 'tier.test').members).toEqual(['works outside a suite']);
  });

  it('records what the suite exercises, without the runner API', () => {
    const edges = byName(symbols(), 'formatTier').edges.map((e) => e.name);
    expect(edges).toContain('formatTier');
    expect(edges).toContain('parseTier');
    expect(edges).not.toContain('expect');
    expect(edges).not.toContain('describe');
    expect(edges).not.toContain('beforeEach');
  });

  it('links a suite to the symbols it tests', () => {
    const analyses = ['src/tier.ts', 'src/tier.test.ts'].map(analyze);
    const { symbols: linked } = linkSymbols(root, analyses);
    const suite = byName(linked, 'formatTier');
    const target = suite.edges.find((e) => e.name === 'formatTier');
    expect(target?.id).toBe('src/tier.ts#formatTier');
  });

  it('tags everything in a test file with the test role', async () => {
    const analysis = await analyzeProject(root);
    const inTestFile = analysis.symbols.filter((s) => s.file === 'src/tier.test.ts');
    expect(inTestFile.length).toBeGreaterThan(0);
    expect(inTestFile.every((s) => s.role?.includes('test'))).toBe(true);
    // the source function, not the suite that shares its name
    const source = analysis.symbols.find((x) => x.id === 'src/tier.ts#formatTier')!;
    expect(source.role ?? []).not.toContain('test');
  });
});

describe('coverage in a review', () => {
  const suite = (over: { id: string; covers: string[]; cases: string[]; bodyHash: string }) =>
    makeSymbol({
      id: over.id,
      kind: 'test',
      export: 'none',
      members: over.cases,
      bodyHash: over.bodyHash,
      edges: over.covers.map((id) => ({ kind: 'calls' as const, name: id.split('#')[1], id })),
    });

  const source = (bodyHash: string, members: string[] = ['a']) =>
    makeSymbol({ id: 'src/tier.ts#formatTier', members, bodyHash });

  it('reports a change whose covering suite also changed', () => {
    const prev = makeSnapshot([
      source('v1'),
      suite({ id: 'src/tier.test.ts#s', covers: ['src/tier.ts#formatTier'], cases: ['one'], bodyHash: 't1' }),
    ]);
    const next = makeSnapshot([
      source('v2', ['a', 'b']),
      suite({ id: 'src/tier.test.ts#s', covers: ['src/tier.ts#formatTier'], cases: ['one', 'two'], bodyHash: 't2' }),
    ]);
    const { changes, untested } = reviewSnapshots(prev, next);
    expect(changes.find((c) => c.id === 'src/tier.ts#formatTier')?.tests).toBe('changed');
    expect(untested).toBe(0);
  });

  it('flags a change whose covering suite stood still', () => {
    const stable = suite({
      id: 'src/tier.test.ts#s',
      covers: ['src/tier.ts#formatTier'],
      cases: ['one'],
      bodyHash: 't1',
    });
    const review = reviewSnapshots(
      makeSnapshot([source('v1'), stable]),
      makeSnapshot([source('v2', ['a', 'b']), stable])
    );
    expect(review.changes[0].tests).toBe('unchanged');
    expect(review.untested).toBe(1);
    expect(renderText(review, { from: 'a', to: 'b' })).toContain('no test change');
  });

  it('says so when nothing references the symbol at all', () => {
    const review = reviewSnapshots(
      makeSnapshot([source('v1')]),
      makeSnapshot([source('v2', ['a', 'b'])])
    );
    expect(review.changes[0].tests).toBe('none');
    expect(renderText(review, { from: 'a', to: 'b' })).toContain('no tests reference this');
  });

  it('follows one more hop, so a suite on a router covers what it mounts', () => {
    const procedure = (bodyHash: string) =>
      makeSymbol({ id: 'src/router.ts#appRouter.list', kind: 'procedure', bodyHash });
    const router = makeSymbol({
      id: 'src/router.ts#appRouter',
      edges: [{ kind: 'references', name: 'list', id: 'src/router.ts#appRouter.list' }],
    });
    const suites = (bodyHash: string) =>
      suite({ id: 'src/router.test.ts#s', covers: ['src/router.ts#appRouter'], cases: ['x'], bodyHash });

    const review = reviewSnapshots(
      makeSnapshot([router, procedure('p1'), suites('t1')]),
      makeSnapshot([router, procedure('p2'), suites('t2')])
    );
    expect(review.changes.find((c) => c.id === 'src/router.ts#appRouter.list')?.tests).toBe(
      'changed'
    );
  });

  it('does not nag about schema and config, which no test imports', () => {
    const model = (bodyHash: string, members: string[]) =>
      makeSymbol({ id: 's.prisma#Company', kind: 'model', members, bodyHash });
    const review = reviewSnapshots(
      makeSnapshot([model('m1', ['id: String'])]),
      makeSnapshot([model('m2', ['id: String', 'tier: Int'])])
    );
    expect(review.changes[0].tests).toBeUndefined();
    expect(review.untested).toBe(0);
    expect(renderText(review, { from: 'a', to: 'b' })).not.toContain('no test');
  });

  it('gives test changes their own section', () => {
    const review = reviewSnapshots(
      makeSnapshot([
        suite({ id: 'src/a.test.ts#s', covers: [], cases: ['one'], bodyHash: 't1' }),
      ]),
      makeSnapshot([
        suite({ id: 'src/a.test.ts#s', covers: [], cases: ['one', 'two'], bodyHash: 't2' }),
      ])
    );
    const text = renderText(review, { from: 'a', to: 'b' });
    expect(text).toContain('TESTS (1)');
    expect(text).toContain('+ two');
  });
});

describe('scanning', () => {
  it('no longer skips test files', async () => {
    writeFile(root, 'src/extra.spec.ts', 'describe("extra", () => { it("runs", () => {}); });\n');
    const analysis = await analyzeProject(root);
    expect(analysis.symbols.some((s) => s.file === 'src/extra.spec.ts')).toBe(true);
  });
});
