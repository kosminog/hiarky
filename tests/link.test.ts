import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeFile } from '../src/analyze';
import { linkComponents } from '../src/resolve';
import { ComponentInfo, RenderedChild } from '../src/types';

const ROOT = path.resolve('tests/fixtures/link-project');
const FILES = [
  'src/App.tsx',
  'src/components/Header.tsx',
  'src/components/Item.tsx',
  'src/components/List.tsx',
  'src/components/Orphan.tsx',
  'src/components/index.tsx',
];

let components: ComponentInfo[];
let roots: string[];

const comp = (id: string) => {
  const c = components.find((x) => x.id === id);
  if (!c) throw new Error(`component ${id} not found`);
  return c;
};
const child = (c: ComponentInfo, name: string): RenderedChild => {
  const r = c.renders.find((x) => x.name === name);
  if (!r) throw new Error(`${c.id} does not render ${name}`);
  return r;
};

beforeAll(() => {
  const analyses = FILES.map((f) => analyzeFile(path.join(ROOT, f), f));
  ({ components, roots } = linkComponents(ROOT, analyses));
});

describe('linkComponents', () => {
  it('finds all components across the project', () => {
    // localeCompare ordering: case-insensitive, so index.tsx sorts before Item.tsx
    expect(components.map((c) => c.id)).toEqual([
      'src/App.tsx#App',
      'src/components/Header.tsx#Header',
      'src/components/Header.tsx#Logo',
      'src/components/index.tsx#Footer',
      'src/components/Item.tsx#ListItem',
      'src/components/List.tsx#List',
      'src/components/Orphan.tsx#Orphan',
    ]);
  });

  it('resolves default and named relative imports to component ids', () => {
    const app = comp('src/App.tsx#App');
    expect(child(app, 'Header').id).toBe('src/components/Header.tsx#Header');
    expect(child(app, 'List').id).toBe('src/components/List.tsx#List');
  });

  it('resolves directory imports through index files', () => {
    expect(child(comp('src/App.tsx#App'), 'Footer').id).toBe('src/components/index.tsx#Footer');
  });

  it('marks package imports as external with the package name', () => {
    const panel = child(comp('src/App.tsx#App'), 'UI.Panel');
    expect(panel.id).toBeUndefined();
    expect(panel.external).toBe('ui-kit');
  });

  it('marks unresolvable relative imports as external with the specifier', () => {
    const missing = child(comp('src/App.tsx#App'), 'Missing');
    expect(missing.id).toBeUndefined();
    expect(missing.external).toBe('./nowhere');
  });

  it('resolves same-file, non-exported components', () => {
    expect(child(comp('src/components/Header.tsx#Header'), 'Logo').id).toBe(
      'src/components/Header.tsx#Logo'
    );
  });

  it('follows a default import whose local name differs from the component name', () => {
    expect(child(comp('src/components/List.tsx#List'), 'Item').id).toBe(
      'src/components/Item.tsx#ListItem'
    );
  });

  it('links recursive components to themselves without consuming their root status', () => {
    const list = comp('src/components/List.tsx#List');
    expect(child(list, 'List').id).toBe('src/components/List.tsx#List');
    // List is rendered by App, so it is not a root — but only because of App
    expect(roots).not.toContain('src/components/List.tsx#List');
  });

  it('computes roots as components nothing else renders', () => {
    expect(roots).toEqual(['src/App.tsx#App', 'src/components/Orphan.tsx#Orphan']);
  });
});
