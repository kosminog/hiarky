import { describe, expect, it } from 'vitest';
import { formatDelta, renderMarkdown, renderText } from '../src/report';
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
