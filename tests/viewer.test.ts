import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { buildViewerHtml } from '../src/viewer';
import { Snapshot } from '../src/types';
import { makeComponent, makeSnapshot } from './helpers';

function render(snaps: Snapshot[], name = 'demo-project') {
  const html = buildViewerHtml(snaps, name);
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  return { dom, doc: dom.window.document, win: dom.window as unknown as Record<string, unknown> };
}

const texts = (doc: Document, sel: string) =>
  [...doc.querySelectorAll(sel)].map((e) => e.textContent?.trim());

// Two-snapshot history: Gone removed, New added, Button changed
const app = makeComponent({
  id: 'src/App.tsx#App',
  hooks: [{ name: 'useState', detail: 'count' }],
  renders: [
    { name: 'Button', id: 'src/Button.tsx#Button' },
    { name: 'Router', external: 'react-router' },
  ],
});
const button = makeComponent({ id: 'src/Button.tsx#Button', props: ['label'] });
const gone = makeComponent({ id: 'src/Gone.tsx#Gone' });
const button2 = makeComponent({ id: 'src/Button.tsx#Button', props: ['label', 'kind'] });
const fresh = makeComponent({ id: 'src/New.tsx#New' });

const snapA = makeSnapshot([app, button, gone], { timestamp: '2026-01-01T00:00:00.000Z' });
const snapB = makeSnapshot([app, button2, fresh], { timestamp: '2026-01-02T00:00:00.000Z' });

describe('viewer timeline', () => {
  it('renders one entry per snapshot with the latest active', () => {
    const { doc } = render([snapA, snapB]);
    const items = doc.querySelectorAll('.snap-item');
    expect(items).toHaveLength(2);
    expect(items[1].classList.contains('active')).toBe(true);
  });

  it('shows diff badges from the shared diff logic', () => {
    const { doc } = render([snapA, snapB]);
    const second = doc.querySelectorAll('.snap-item')[1];
    expect(second.querySelector('.badge.added')?.textContent).toBe('+1');
    expect(second.querySelector('.badge.removed')?.textContent).toBe('−1');
    expect(second.querySelector('.badge.changed')?.textContent).toBe('~1');
  });
});

describe('viewer tree', () => {
  it('renders the hierarchy with hook counts and external packages', () => {
    const { doc } = render([snapA, snapB]);
    const names = texts(doc, '.node-name');
    expect(names).toContain('App');
    expect(names).toContain('Button');
    expect(names).toContain('New');
    expect(texts(doc, '.node-name.external')).toContain('Router');
    expect(texts(doc, '.pkg')).toContain('react-router');
    expect(texts(doc, '.hookcount')).toContain('1 hook');
  });

  it('marks added and changed components with dots', () => {
    const { doc } = render([snapA, snapB]);
    expect(doc.querySelectorAll('.dot.added')).toHaveLength(1); // New
    expect(doc.querySelectorAll('.dot.changed')).toHaveLength(1); // Button
  });

  it('lists components removed since the previous snapshot', () => {
    const { doc } = render([snapA, snapB]);
    expect(doc.querySelector('#removed')?.textContent).toContain('src/Gone.tsx#Gone');
  });

  it('terminates on cyclic hierarchies via the recursive marker', () => {
    const a = makeComponent({ id: 'src/A.tsx#A', renders: [{ name: 'B', id: 'src/B.tsx#B' }] });
    const b = makeComponent({ id: 'src/B.tsx#B', renders: [{ name: 'A', id: 'src/A.tsx#A' }] });
    const { doc } = render([makeSnapshot([a, b])]);
    expect(doc.querySelectorAll('.cycle').length).toBeGreaterThan(0);
    expect(texts(doc, '.node-name')).toContain('A');
  });
});

describe('viewer interaction', () => {
  it('shows the detail panel when a component is clicked', () => {
    const { doc } = render([snapA, snapB]);
    const node = [...doc.querySelectorAll('.node-name')].find(
      (e) => e.textContent === 'Button'
    ) as HTMLButtonElement;
    node.click();
    expect(doc.querySelector('#detail h3')?.textContent).toBe('Button');
    expect(texts(doc, '#detail .prop')).toEqual(['label', 'kind']);
  });

  it('navigates snapshots with arrow keys', () => {
    const { dom, doc } = render([snapA, snapB]);
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    const items = doc.querySelectorAll('.snap-item');
    expect(items[0].classList.contains('active')).toBe(true);
    const names = texts(doc, '.node-name');
    expect(names).toContain('Gone');
    expect(names).not.toContain('New');
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(doc.querySelectorAll('.snap-item')[1].classList.contains('active')).toBe(true);
  });
});

describe('viewer safety', () => {
  it('never executes markup smuggled in component data or project name', () => {
    const evil = makeComponent({
      id: 'src/Evil.tsx#<img src=x onerror="window.__pwned=1">',
      props: ['</script><script>window.__pwned2=1</script>'],
    });
    const { doc, win } = render([makeSnapshot([evil])], '<script>window.__pwned3=1</script>');
    // Page survived (single script, tree rendered as plain text)
    expect(doc.querySelectorAll('script')).toHaveLength(1);
    expect(doc.querySelector('img')).toBeNull();
    expect(texts(doc, '.node-name')).toContain('<img src=x onerror="window.__pwned=1">');
    expect(win.__pwned).toBeUndefined();
    expect(win.__pwned2).toBeUndefined();
    expect(win.__pwned3).toBeUndefined();
    expect(doc.querySelector('header .project')?.textContent).toBe(
      '<script>window.__pwned3=1</script>'
    );
  });

  it('shows an empty state when there are no snapshots', () => {
    const { doc } = render([]);
    expect(doc.querySelector('main')?.textContent).toContain('No snapshots yet');
  });
});
