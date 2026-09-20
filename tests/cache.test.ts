import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentKeys, nullCache, openCache } from '../src/cache';
import { analyzeProject } from '../src/snap';
import { cleanup, commitAll, initRepo, makeProject, writeFile } from './helpers';

const BUTTON = 'export function Button({ label }: { label: string }) {\n  return <button>{label}</button>;\n}\n';

const roots: string[] = [];
const project = (files: Record<string, string>) => {
  const root = makeProject(files);
  roots.push(root);
  return root;
};

afterEach(() => {
  while (roots.length) cleanup(roots.pop()!);
});

describe('contentKeys', () => {
  it('uses git blob hashes for committed files', () => {
    const root = project({ 'src/Button.tsx': BUTTON });
    initRepo(root);
    commitAll(root, 'init', '2026-01-01T00:00:00Z');
    const keys = contentKeys(root, ['src/Button.tsx']);
    expect(keys.get('src/Button.tsx')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('re-hashes a file modified since the index was written', () => {
    const root = project({ 'src/Button.tsx': BUTTON });
    initRepo(root);
    commitAll(root, 'init', '2026-01-01T00:00:00Z');
    const before = contentKeys(root, ['src/Button.tsx']).get('src/Button.tsx');
    writeFile(root, 'src/Button.tsx', BUTTON.replace(/label/g, 'title'));
    const after = contentKeys(root, ['src/Button.tsx']).get('src/Button.tsx');
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it('hashes files outside a git repository', () => {
    const root = project({ 'src/Button.tsx': BUTTON });
    expect(contentKeys(root, ['src/Button.tsx']).get('src/Button.tsx')).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('analysis cache', () => {
  it('round-trips an entry through disk', () => {
    const root = project({});
    const cache = openCache(root);
    cache.set('javascript', 'src/a.ts', 'key1', {
      file: 'src/a.ts',
      symbols: [],
      imports: [],
      reexports: [],
    });
    cache.flush();

    const reopened = openCache(root);
    expect(reopened.get('javascript', 'src/a.ts', 'key1')?.file).toBe('src/a.ts');
    expect(reopened.get('javascript', 'src/a.ts', 'other')).toBeNull();
    expect(reopened.get('python', 'src/a.ts', 'key1')).toBeNull();
  });

  it('hands out an independent copy each time, since linking mutates', () => {
    const root = project({});
    const cache = openCache(root);
    cache.set('javascript', 'src/a.ts', 'k', {
      file: 'src/a.ts',
      symbols: [
        {
          id: 'src/a.ts#A',
          name: 'A',
          file: 'src/a.ts',
          lang: 'ts',
          kind: 'function',
          export: 'named',
          edges: [{ kind: 'calls', name: 'b' }],
          bodyHash: 'h',
        },
      ],
      imports: [],
      reexports: [],
    });

    const first = cache.get('javascript', 'src/a.ts', 'k')!;
    first.symbols[0].edges[0].id = 'resolved-elsewhere';
    const second = cache.get('javascript', 'src/a.ts', 'k')!;
    expect(second.symbols[0].edges[0].id).toBeUndefined();
  });

  it('keeps itself out of git status', () => {
    const root = project({});
    const cache = openCache(root);
    cache.set('javascript', 'a.ts', 'k', { file: 'a.ts', symbols: [], imports: [], reexports: [] });
    cache.flush();
    expect(fs.readFileSync(path.join(root, '.hiarky', 'cache', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('records nothing when disabled', () => {
    const cache = nullCache();
    cache.set('javascript', 'a.ts', 'k', { file: 'a.ts', symbols: [], imports: [], reexports: [] });
    cache.flush();
    expect(cache.get('javascript', 'a.ts', 'k')).toBeNull();
  });
});

describe('cached project analysis', () => {
  it('reuses results and produces the same symbols', async () => {
    const root = project({ 'src/Button.tsx': BUTTON, 'src/App.tsx': BUTTON.replace('Button', 'App') });
    const cache = openCache(root);

    const cold = await analyzeProject(root, { cache });
    expect(cache.stats.hits).toBe(0);
    expect(cache.stats.misses).toBeGreaterThan(0);

    const warm = await analyzeProject(root, { cache });
    expect(cache.stats.hits).toBeGreaterThan(0);
    expect(warm.symbols).toEqual(cold.symbols);
    expect(warm.roots).toEqual(cold.roots);
  });

  it('re-analyzes only what changed', async () => {
    const root = project({ 'src/Button.tsx': BUTTON, 'src/App.tsx': BUTTON.replace('Button', 'App') });
    const cache = openCache(root);
    await analyzeProject(root, { cache });

    writeFile(root, 'src/Button.tsx', BUTTON.replace(/label/g, 'title'));
    const before = { ...cache.stats };
    const after = await analyzeProject(root, { cache });

    expect(cache.stats.misses - before.misses).toBe(1); // only Button.tsx
    const button = after.symbols.find((s) => s.name === 'Button')!;
    expect(button.members).toEqual(['title']);
  });

  it('is not consulted when no cache is supplied', async () => {
    const root = project({ 'src/Button.tsx': BUTTON });
    const first = await analyzeProject(root);
    const second = await analyzeProject(root);
    expect(second.symbols).toEqual(first.symbols);
  });
});
