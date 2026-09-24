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

describe('procedure input schemas', () => {
  const FILES: Record<string, string> = {
    'src/lib/filters.ts': `import { z } from "zod";
const filterShape = {
  datasetId: z.string(),
  from: z.string().optional(),
};
export const filterSchema = z.object(filterShape);
export const pagingSchema = z.object({ limit: z.number(), cursor: z.string() });
`,
    'src/lib/index.ts': 'export * from "./filters";\n',
    'src/server/queries.ts': `import { z } from "zod";
import { filterSchema, pagingSchema } from "../lib";
export const listSchema = filterSchema.merge(pagingSchema);
export const detailSchema = filterSchema.extend({ id: z.string() }).omit({ from: true });
`,
    'src/server/router.ts': `import { z } from "zod";
import * as queries from "./queries";
import { listSchema } from "./queries";
import { filterSchema } from "../lib";
import { remoteSchema } from "some-package";
import { createTRPCRouter, publicProcedure } from "./trpc";

const localSchema = filterSchema.pick({ datasetId: true });

export const dataRouter = createTRPCRouter({
  list: publicProcedure.input(listSchema).query(() => []),
  detail: publicProcedure.input(queries.detailSchema).query(() => null),
  local: publicProcedure.input(localSchema).query(() => null),
  extended: publicProcedure.input(listSchema.extend({ sort: z.string() })).query(() => null),
  remote: publicProcedure.input(remoteSchema).query(() => null),
  inline: publicProcedure.input(z.object({ q: z.string() })).query(() => null),
});
`,
  };

  let linked: SymbolInfo[];
  beforeAll(() => {
    const root = makeProject(FILES);
    try {
      const analyses = Object.keys(FILES).map((f) => analyzeFile(path.join(root, f), f));
      linked = linkSymbols(root, analyses).symbols;
    } finally {
      cleanup(root);
    }
  });
  const membersOf = (name: string) => linked.find((s) => s.name === name)?.members;

  it('expands schemas imported directly, through a barrel, or by namespace', () => {
    expect(membersOf('dataRouter.list')).toEqual(['datasetId', 'from', 'limit', 'cursor']);
    expect(membersOf('dataRouter.detail')).toEqual(['datasetId', 'id']);
  });

  it('expands same-file schemas and chains applied at the call site', () => {
    expect(membersOf('dataRouter.local')).toEqual(['datasetId']);
    expect(membersOf('dataRouter.extended')).toEqual([
      'datasetId',
      'from',
      'limit',
      'cursor',
      'sort',
    ]);
    expect(membersOf('dataRouter.inline')).toEqual(['q']);
  });

  it('records the fields of the schema declarations themselves', () => {
    expect(membersOf('filterSchema')).toEqual(['datasetId', 'from']);
    expect(membersOf('listSchema')).toEqual(['datasetId', 'from', 'limit', 'cursor']);
  });

  it('leaves schemas from outside the project without fields', () => {
    expect(membersOf('dataRouter.remote')).toBeUndefined();
  });

  it('removes the unresolved shapes once linked', () => {
    expect(linked.filter((s) => s.schema)).toEqual([]);
  });
});

describe('schema cycles', () => {
  it('terminates on schemas that extend each other', () => {
    const root = makeProject({
      'src/a.ts': 'import { b } from "./b";\nexport const a = b.extend({ x: z.string() });\n',
      'src/b.ts': 'import { a } from "./a";\nexport const b = a.extend({ y: z.string() });\n',
    });
    try {
      const files = ['src/a.ts', 'src/b.ts'];
      const analyses = files.map((f) => analyzeFile(path.join(root, f), f));
      const { symbols } = linkSymbols(root, analyses);
      expect(symbols.find((s) => s.name === 'a')?.members).toEqual(['y', 'x']);
      expect(symbols.find((s) => s.name === 'b')?.members).toEqual(['y']);
    } finally {
      cleanup(root);
    }
  });
});
