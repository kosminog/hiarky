import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeFile } from '../src/analyze';
import { linkSymbols } from '../src/resolve';
import { Edge, edgesOf, SymbolInfo } from '../src/types';
import { cleanup, makeProject } from './helpers';

const ROOT = path.resolve('tests/fixtures/link-project');
const FILES = [
  'src/App.tsx',
  'src/components/Header.tsx',
  'src/components/Item.tsx',
  'src/components/List.tsx',
  'src/components/Orphan.tsx',
  'src/components/index.tsx',
];

let symbols: SymbolInfo[];
let roots: string[];

const comp = (id: string) => {
  const c = symbols.find((x) => x.id === id);
  if (!c) throw new Error(`symbol ${id} not found`);
  return c;
};
const child = (c: SymbolInfo, name: string): Edge => {
  const r = edgesOf(c, 'renders').find((x) => x.name === name);
  if (!r) throw new Error(`${c.id} does not render ${name}`);
  return r;
};

beforeAll(() => {
  const analyses = FILES.map((f) => analyzeFile(path.join(ROOT, f), f));
  ({ symbols, roots } = linkSymbols(ROOT, analyses));
});

describe('linkSymbols', () => {
  it('finds all components across the project', () => {
    // localeCompare ordering: case-insensitive, so index.tsx sorts before Item.tsx
    expect(symbols.filter((s) => s.kind === 'component').map((c) => c.id)).toEqual([
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

describe('renamed exports', () => {
  it('links imports of a local declaration exported under another name', () => {
    const root = makeProject({
      'src/Button.tsx':
        'function InnerButton() {\n  return <button />;\n}\nexport { InnerButton as Button, InnerButton as default };\n',
      'src/App.tsx':
        'import Default, { Button } from "./Button";\nexport function App() {\n  return <><Button /><Default /></>;\n}\n',
    });
    try {
      const files = ['src/Button.tsx', 'src/App.tsx'];
      const analyses = files.map((f) => analyzeFile(path.join(root, f), f));
      const linked = linkSymbols(root, analyses);
      const app = linked.symbols.find((s) => s.name === 'App')!;
      expect(edgesOf(app, 'renders').map((e) => e.id)).toEqual([
        'src/Button.tsx#InnerButton',
        'src/Button.tsx#InnerButton',
      ]);
      expect(linked.symbols.find((s) => s.name === 'InnerButton')?.export).toBe('default');
    } finally {
      cleanup(root);
    }
  });
});
