import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeFile } from '../src/analyze';
import { loadResolverContext, parseJsonc, ResolverContext, resolveSpecifier } from '../src/modules';
import { linkSymbols } from '../src/resolve';
import { edgesOf, SymbolInfo } from '../src/types';
import { cleanup, makeProject } from './helpers';

const FILES = [
  'apps/web/src/app/page.tsx',
  'apps/web/src/app/detail.tsx',
  'apps/web/src/lib/utils.ts',
  'apps/web/src/trpc/server.ts',
  'apps/web/src/components/button.tsx',
  'apps/web/src/components/card.tsx',
  'apps/web/src/components/index.ts',
  'apps/lib/src/index.ts',
  'apps/lib/src/helper.ts',
];

let root: string;
let ctx: ResolverContext;
let symbols: SymbolInfo[];

const sym = (id: string) => {
  const s = symbols.find((x) => x.id === id);
  if (!s) throw new Error(`symbol ${id} not found in [${symbols.map((x) => x.id)}]`);
  return s;
};

beforeAll(() => {
  root = makeProject({
    'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n',
    // jsonc: block comments, line comments, and a trailing comma
    'apps/web/tsconfig.json': `{
  /* Base options */
  "compilerOptions": {
    "baseUrl": ".",
    // Path aliases
    "paths": {
      "~/*": ["./src/*"],
    },
  },
}
`,
    'apps/web/package.json': JSON.stringify({ name: '@acme/web' }),
    'apps/lib/package.json': JSON.stringify({ name: '@acme/lib', main: 'src/index.ts' }),
    'apps/web/src/app/page.tsx': `import { Button } from "~/components/button";
import { Card } from "~/components";
import { greet } from "@acme/lib";
import { useState } from "react";

export default function Page() {
  const [open, setOpen] = useState(false);
  greet("hi");
  return <><Button /><Card /></>;
}
`,
    'apps/web/src/components/button.tsx': 'export function Button() {\n  return <button />;\n}\n',
    'apps/web/src/components/card.tsx': 'export function Card() {\n  return <div />;\n}\n',
    'apps/web/src/components/index.ts': `export * from "./card";
export { Button as PrimaryButton } from "./button";
`,
    'apps/lib/src/index.ts': 'export { greet } from "./helper";\n',
    'apps/lib/src/helper.ts': 'export function greet(name: string) {\n  return `hi ${name}`;\n}\n',
    // A barrel that re-exports a third-party package, t3-style destructured exports
    'apps/web/src/lib/utils.ts': 'export { cn } from "clsx";\n',
    'apps/web/src/trpc/server.ts': `import { createHelpers } from "@trpc/rsc";

export const { trpc: api, HydrateClient } = createHelpers();
`,
    'apps/web/src/app/detail.tsx': `import { cn } from "~/lib/utils";
import { api } from "~/trpc/server";

export function Detail() {
  const data = api.list();
  return <div className={cn("x")}>{data}</div>;
}
`,
  });
  ctx = loadResolverContext(root);
  const analyses = FILES.map((f) => analyzeFile(path.join(root, f), f));
  ({ symbols } = linkSymbols(root, analyses, ctx));
});

afterAll(() => cleanup(root));

describe('parseJsonc', () => {
  it('handles block comments, line comments, and trailing commas', () => {
    expect(parseJsonc('{ /* a */ "x": 1, // b\n "y": [2, 3,], }')).toEqual({ x: 1, y: [2, 3] });
  });

  it('leaves comment-like text inside strings alone', () => {
    expect(parseJsonc('{ "url": "https://x.dev/*not a comment*/" }')).toEqual({
      url: 'https://x.dev/*not a comment*/',
    });
  });
});

describe('resolveSpecifier', () => {
  const from = 'apps/web/src/app/page.tsx';

  it('resolves tsconfig path aliases', () => {
    expect(resolveSpecifier(ctx, from, '~/components/button')).toBe(
      'apps/web/src/components/button.tsx'
    );
  });

  it('resolves an alias that lands on a directory index', () => {
    expect(resolveSpecifier(ctx, from, '~/components')).toBe('apps/web/src/components/index.ts');
  });

  it('resolves workspace package names through the package manifest', () => {
    expect(resolveSpecifier(ctx, from, '@acme/lib')).toBe('apps/lib/src/index.ts');
  });

  it('resolves a subpath inside a workspace package', () => {
    expect(resolveSpecifier(ctx, from, '@acme/lib/helper')).toBe('apps/lib/src/helper.ts');
  });

  it('still resolves ordinary relative imports', () => {
    expect(resolveSpecifier(ctx, 'apps/lib/src/index.ts', './helper')).toBe(
      'apps/lib/src/helper.ts'
    );
  });

  it('returns null for real third-party packages', () => {
    expect(resolveSpecifier(ctx, from, 'react')).toBeNull();
    expect(resolveSpecifier(ctx, from, './nope')).toBeNull();
  });
});

describe('linkSymbols across aliases, barrels, and packages', () => {
  const page = () => sym('apps/web/src/app/page.tsx#Page');
  const edge = (name: string) => {
    const e = [...edgesOf(page(), 'renders'), ...edgesOf(page(), 'calls')].find(
      (x) => x.name === name
    );
    if (!e) throw new Error(`no edge ${name}`);
    return e;
  };

  it('links an alias-imported component', () => {
    expect(edge('Button').id).toBe('apps/web/src/components/button.tsx#Button');
  });

  it('follows `export * from` through a barrel file', () => {
    expect(edge('Card').id).toBe('apps/web/src/components/card.tsx#Card');
  });

  it('links a call into another workspace package, through its barrel', () => {
    expect(edge('greet').id).toBe('apps/lib/src/helper.ts#greet');
  });

  it('leaves genuine package imports external', () => {
    expect(page().hooks?.map((h) => h.name)).toEqual(['useState']);
    expect(edgesOf(page(), 'calls').some((e) => e.name === 'useState')).toBe(false);
  });

  it('emits a symbol per name in a destructured export', () => {
    expect(symbols.filter((s) => s.file === 'apps/web/src/trpc/server.ts').map((s) => s.name))
      .toEqual(['api', 'HydrateClient']);
    expect(sym('apps/web/src/trpc/server.ts#api').export).toBe('named');
  });

  it('links a call to a destructured export', () => {
    const detail = sym('apps/web/src/app/detail.tsx#Detail');
    const call = edgesOf(detail, 'calls').find((e) => e.name === 'api.list');
    expect(call?.id).toBe('apps/web/src/trpc/server.ts#api');
  });

  it('reports the real package when a barrel re-exports one', () => {
    const detail = sym('apps/web/src/app/detail.tsx#Detail');
    const call = edgesOf(detail, 'calls').find((e) => e.name === 'cn');
    // Imported as "~/lib/utils", but that file is just `export { cn } from "clsx"`
    expect(call?.id).toBeUndefined();
    expect(call?.external).toBe('clsx');
  });

  it('counts an alias-imported component as rendered, not a root', () => {
    const { roots } = linkSymbols(
      root,
      FILES.map((f) => analyzeFile(path.join(root, f), f)),
      ctx
    );
    expect(roots).toEqual([
      'apps/web/src/app/detail.tsx#Detail',
      'apps/web/src/app/page.tsx#Page',
    ]);
  });
});
