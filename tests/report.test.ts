import { describe, expect, it } from 'vitest';
import { formatDelta, renderGithub, renderMarkdown, renderText } from '../src/report';
import { reviewSnapshots } from '../src/review';
import { makeComponent, makeSnapshot, makeSymbol } from './helpers';

const CTX = { from: 'aaaaaaa', to: 'bbbbbbb', commits: 2, files: 4 };

describe('formatDelta', () => {
  it('prefixes additions and removals', () => {
    expect(formatDelta({ field: 'members', added: ['b'], removed: ['a'] }, 'function')).toBe(
      'members: +b -a'
    );
  });

  it('calls members "props" on a component', () => {
    expect(formatDelta({ field: 'members', added: ['title'] }, 'component')).toBe('props: +title');
  });

  it('shows both sides of a scalar change', () => {
    expect(formatDelta({ field: 'signature', from: '()', to: '(x: number)' }, 'function')).toBe(
      'signature: () → (x: number)'
    );
  });

  it('truncates a long entry list rather than dumping it', () => {
    const added = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const line = formatDelta({ field: 'calls', added }, 'function');
    expect(line).toBe('calls: +a +b +c +d +e +f … (2 more)');
  });

  it('truncates an overlong signature', () => {
    const long = '(' + 'x'.repeat(200) + ')';
    const line = formatDelta({ field: 'signature', from: '()', to: long }, 'function');
    expect(line.length).toBeLessThan(120);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('rendering', () => {
  const prev = makeSnapshot([
    makeComponent({ id: 'src/Header.tsx#Header', members: ['title'], bodyHash: 'h1' }),
    makeSymbol({ id: 'src/api.ts#legacy', bodyHash: 'l1' }),
    makeSymbol({ id: 'src/util.ts#quiet', export: 'none', bodyHash: 'q1' }),
    makeSymbol({ id: 'src/old/moved.ts#shifted', bodyHash: 'm1' }),
  ]);
  const next = makeSnapshot([
    makeComponent({ id: 'src/Header.tsx#Header', members: ['title', 'subtitle'], bodyHash: 'h2' }),
    makeSymbol({ id: 'src/util.ts#quiet', export: 'none', bodyHash: 'q2' }),
    makeSymbol({ id: 'src/new/moved.ts#shifted', bodyHash: 'm1' }),
    makeSymbol({ id: 'src/fresh.ts#alpha' }),
    makeSymbol({ id: 'src/fresh.ts#beta' }),
  ]);
  const review = reviewSnapshots(prev, next);

  it('leads the markdown with scope and counts', () => {
    const md = renderMarkdown(review, CTX);
    expect(md).toContain('## hiarky review');
    expect(md).toContain('aaaaaaa → bbbbbbb · 2 commits · 4 files touched');
    expect(md).toContain('2 added · 1 removed · 2 changed · 1 moved');
  });

  it('summarizes a brand-new file instead of listing each symbol', () => {
    const md = renderMarkdown(review, CTX);
    expect(md).toContain('### New files (1)');
    expect(md).toContain('`src/fresh.ts` — 2 symbols, 2 exported');
    expect(md).not.toContain('src/fresh.ts#alpha');
  });

  it('puts the removed export above the prop change, and both above the body edit', () => {
    const text = renderText(review, CTX);
    const order = ['src/api.ts#legacy', 'src/Header.tsx#Header', 'src/util.ts#quiet'];
    const positions = order.map((id) => text.indexOf(id));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('shows a move as one entry with both ids', () => {
    expect(renderText(review, CTX)).toContain(
      'src/old/moved.ts#shifted -> src/new/moved.ts#shifted'
    );
  });

  it('collapses body-only changes into their own section', () => {
    const text = renderText(review, CTX);
    expect(text).toContain('BODY ONLY (1)');
    const md = renderMarkdown(review, CTX);
    expect(md).toContain('<details><summary>1 body-only change</summary>');
  });

  it('names the files whose public surface changed', () => {
    expect(renderMarkdown(review, CTX)).toContain('3 files changed their public surface');
  });

  it('says so plainly when nothing changed', () => {
    const same = reviewSnapshots(prev, prev);
    expect(renderText(same, CTX)).toContain('No symbol-level changes');
    expect(renderMarkdown(same, CTX)).toContain('No symbol-level changes');
  });
});

describe('github rendering', () => {
  // Untouched code that calls the changed function: present on both sides
  const caller = makeSymbol({
    id: 'src/admin.ts#list',
    edges: [{ kind: 'calls', name: 'fetchUser', id: 'src/api.ts#fetchUser' }],
  });
  const prev = makeSnapshot([
    makeSymbol({ id: 'src/api.ts#fetchUser', signature: '(id: string)', bodyHash: 'a1' }),
    makeSymbol({ id: 'src/api.ts#gone', bodyHash: 'g1' }),
    makeComponent({ id: 'src/Header.tsx#Header', members: ['title'], bodyHash: 'h1' }),
    makeSymbol({ id: 'src/weird.ts#say"hi"<T>', signature: '()', bodyHash: 'w1' }),
    caller,
  ]);
  const next = makeSnapshot([
    makeSymbol({
      id: 'src/api.ts#fetchUser',
      signature: '(id: string, opts: { a | b })',
      bodyHash: 'a2',
    }),
    makeComponent({ id: 'src/Header.tsx#Header', members: ['title', 'subtitle'], bodyHash: 'h2' }),
    caller,
    makeSymbol({ id: 'src/weird.ts#say"hi"<T>', signature: '(x)', bodyHash: 'w2' }),
  ]);
  const review = reviewSnapshots(prev, next);
  const md = renderGithub(review, CTX);

  it('opens with the headline and the summary tiles', () => {
    expect(md).toContain('## hiarky review');
    expect(md).toContain('| **Impact** |');
    expect(md).toContain('| **Public surface** |');
    expect(md).toMatch(/\| \*\*Impact\*\* \| `[█░]{12}` \| 4 high · 0 worth a look · 0 minor \|/);
  });

  it('counts changes by kind, most consequential first', () => {
    expect(md).toContain('### What changed, by kind');
    const rows = md.split('\n').filter((l) => /^\| (component|function) \|/.test(l));
    expect(rows[0]).toMatch(/^\| component \|/);
    expect(rows[1]).toMatch(/^\| function \|/);
  });

  it('draws the blast radius with dependents collapsed per file', () => {
    expect(md).toContain('```mermaid');
    expect(md).toContain('flowchart LR');
    expect(md).toContain('subgraph n1["src/api.ts"]');
    expect(md).toContain('["fetchUser ⚠<br/><i>signature</i>"]:::high');
    expect(md).toContain('(["src/admin.ts<br/>1 dependent"]):::dep');
    expect(md).toContain('["gone ⚠<br/><i>removed</i>"]:::removed');
  });

  it('escapes what Mermaid would misread in a label', () => {
    expect(md).toContain('say#quot;hi#quot;#lt;T#gt;');
    expect(md).not.toContain('say"hi"<T>"]');
  });

  it('tabulates the public surface before and after', () => {
    expect(md).toContain('### Public surface');
    expect(md).toContain('| `fetchUser` · signature | `(id: string)` | `(id: string, opts: { a \\| b })` |');
    expect(md).toContain('| `Header` · props | | `+subtitle` |');
    expect(md).toContain('| `gone` | function | _removed_ |');
  });

  it('ranks files and flags the ones whose surface changed', () => {
    expect(md).toContain('### Files');
    expect(md).toMatch(/\| `src\/api\.ts` \| \+0 −1 ~1 \| `[█░]{8}` 40 \| surface · 2 untested \|/);
  });

  it('folds the full report below the summary', () => {
    expect(md).toContain('<details><summary>Full report</summary>');
    expect(md).toContain('### High impact');
    expect(md.trimEnd().endsWith('</details>')).toBe(true);
  });

  it('skips the graph when nothing depends on anything', () => {
    const lone = reviewSnapshots(
      makeSnapshot([makeSymbol({ id: 'src/a.ts#f', signature: '()', bodyHash: '1' })]),
      makeSnapshot([makeSymbol({ id: 'src/a.ts#f', signature: '(x)', bodyHash: '2' })])
    );
    const out = renderGithub(lone, CTX);
    expect(out).not.toContain('mermaid');
    expect(out).toContain('### Public surface');
  });

  it('drops sections from the bottom to fit a comment', () => {
    const many = Array.from({ length: 3000 }, (_, i) =>
      makeSymbol({ id: `src/m${i}.ts#fn${i}`, bodyHash: 'x' })
    );
    const bumped = many.map((s) => ({ ...s, bodyHash: 'y' }));
    const huge = renderGithub(reviewSnapshots(makeSnapshot(many), makeSnapshot(bumped)), CTX);
    expect(huge.length).toBeLessThanOrEqual(60000);
    expect(huge).toContain('### What changed, by kind');
    expect(huge).not.toContain('Full report');
  });

  it('says so plainly when nothing changed', () => {
    expect(renderGithub(reviewSnapshots(prev, prev), CTX)).toContain('No symbol-level changes');
  });
});
