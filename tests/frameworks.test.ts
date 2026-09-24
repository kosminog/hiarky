import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { analyzeFile } from '../src/analyze';
import {
  isHttpMethod,
  routeFileInfo,
  schemaFields,
  schemaShapeOf,
  trpcRouterOf,
} from '../src/extractors/frameworks';
import { linkSymbols } from '../src/resolve';
import { cleanup, makeProject, writeFile } from './helpers';

describe('routeFileInfo', () => {
  const urlOf = (file: string) => routeFileInfo(file)?.urlPath;

  it('maps a page to its directory path', () => {
    expect(urlOf('apps/web/src/app/roles/page.tsx')).toBe('/roles');
    expect(urlOf('apps/web/src/app/page.tsx')).toBe('/');
  });

  it('drops route groups and parallel slots', () => {
    expect(urlOf('src/app/dashboard/(shell)/company/[id]/page.tsx')).toBe(
      '/dashboard/company/:id'
    );
    expect(urlOf('src/app/@modal/settings/page.tsx')).toBe('/settings');
  });

  it('translates catch-all segments', () => {
    expect(urlOf('src/app/api/auth/[...all]/route.ts')).toBe('/api/auth/*all');
    expect(urlOf('src/app/dashboard/[[...slug]]/page.tsx')).toBe('/dashboard/*slug?');
  });

  it('reports which special file it is', () => {
    expect(routeFileInfo('src/app/dashboard/layout.tsx')?.role).toBe('layout');
    expect(routeFileInfo('src/app/api/health/route.ts')?.role).toBe('route');
  });

  it('ignores files outside an app directory or with other names', () => {
    expect(routeFileInfo('src/components/page.css')).toBeNull();
    expect(routeFileInfo('src/lib/helpers.ts')).toBeNull();
    expect(routeFileInfo('src/pages/about.tsx')).toBeNull();
  });

  it('knows the HTTP handler names', () => {
    expect(isHttpMethod('GET')).toBe(true);
    expect(isHttpMethod('Get')).toBe(false);
  });
});

describe('trpcRouterOf', () => {
  const routerFrom = (code: string) => {
    const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
    const stmt = ast.program.body[0];
    if (!t.isVariableDeclaration(stmt)) throw new Error('expected a declaration');
    return trpcRouterOf(stmt.declarations[0].init as t.Node);
  };

  it('reads procedures with their operation, builder, and input fields', () => {
    const router = routerFrom(`const r = createTRPCRouter({
      list: protectedProcedure.query(async ({ ctx }) => ctx.db.x.findMany()),
      create: protectedProcedure
        .input(z.object({ name: z.string(), tier: z.number() }))
        .mutation(async ({ input }) => input),
      ping: publicProcedure.query(() => 'pong'),
    });`);
    expect(router?.procedures).toEqual([
      { key: 'list', operation: 'query', builder: 'protectedProcedure', input: null, node: expect.anything() },
      {
        key: 'create',
        operation: 'mutation',
        builder: 'protectedProcedure',
        input: { parts: ['name', 'tier'] },
        node: expect.anything(),
      },
      { key: 'ping', operation: 'query', builder: 'publicProcedure', input: null, node: expect.anything() },
    ]);
  });

  it('records mounted sub-routers', () => {
    const router = routerFrom(`const appRouter = createTRPCRouter({
      artifact: artifactRouter,
      company: companyRouter,
    });`);
    expect(router?.mounts).toEqual([
      { key: 'artifact', name: 'artifactRouter' },
      { key: 'company', name: 'companyRouter' },
    ]);
    expect(router?.procedures).toEqual([]);
  });

  it('finds the zod object through a wrapped input schema', () => {
    const router = routerFrom(`const r = createTRPCRouter({
      save: publicProcedure
        .input(z.object({ id: z.string() }).refine(() => true))
        .mutation(() => null),
    });`);
    expect(router?.procedures[0].input).toEqual({ parts: ['id'] });
  });

  it('keeps an imported input schema as a reference', () => {
    const router = routerFrom(`const r = createTRPCRouter({
      list: publicProcedure.input(listSchema).query(() => []),
    });`);
    expect(router?.procedures[0].input).toEqual({ ref: 'listSchema' });
  });

  it('returns null for anything that is not a router', () => {
    expect(routerFrom('const x = makeThing({ a: 1 });')).toBeNull();
    expect(routerFrom('const x = 5;')).toBeNull();
  });
});

describe('schemaShapeOf', () => {
  const shapeOf = (code: string) => {
    const ast = parse(`(${code})`, { sourceType: 'module', plugins: ['typescript'] });
    const stmt = ast.program.body[0];
    if (!t.isExpressionStatement(stmt)) throw new Error('expected an expression');
    return schemaShapeOf(stmt.expression);
  };
  const fieldsOf = (code: string, refs: Record<string, string[]> = {}) => {
    const shape = shapeOf(code);
    return shape ? schemaFields(shape, (name) => refs[name] ?? null) : null;
  };

  it('reads object schemas, including shapes passed by name', () => {
    expect(fieldsOf('z.object({ a: z.string(), "b": z.number() })')).toEqual(['a', 'b']);
    expect(fieldsOf('z.strictObject({ a: z.string() }).optional()')).toEqual(['a']);
    expect(shapeOf('z.object(filterShape)')).toEqual({ parts: [{ ref: 'filterShape' }] });
  });

  it('follows extend, merge, pick, and omit over referenced schemas', () => {
    const refs = { base: ['a', 'b', 'c'], other: ['d'] };
    expect(fieldsOf('base.extend({ x: z.string(), a: z.string() })', refs)).toEqual([
      'a',
      'b',
      'c',
      'x',
    ]);
    expect(fieldsOf('base.merge(other).partial()', refs)).toEqual(['a', 'b', 'c', 'd']);
    expect(fieldsOf('base.pick({ c: true, a: true })', refs)).toEqual(['a', 'c']);
    expect(fieldsOf('base.omit({ b: true }).extend(other.shape)', refs)).toEqual(['a', 'c', 'd']);
    expect(fieldsOf('z.object({ ...base.shape, y: z.number() })', refs)).toEqual([
      'a',
      'b',
      'c',
      'y',
    ]);
  });

  it('contributes nothing for a reference it cannot expand', () => {
    expect(fieldsOf('external.extend({ x: z.string() })')).toEqual(['x']);
  });

  it('returns null for expressions that are not object schemas', () => {
    expect(shapeOf('z.string().min(1)')).toBeNull();
    expect(shapeOf('makeSchema()')).toBeNull();
    expect(shapeOf('base.pick(["a"])')).toBeNull();
  });
});

describe('framework symbols end to end', () => {
  it('records a page as a route and a handler as a method route', () => {
    const root = makeProject({});
    try {
      writeFile(
        root,
        'src/app/dashboard/(shell)/company/[id]/page.tsx',
        'export default function CompanyPage({ params }: { params: { id: string } }) {\n  return <div>{params.id}</div>;\n}\n'
      );
      writeFile(root, 'src/app/api/health/route.ts', 'export function GET() {\n  return Response.json({ ok: true });\n}\n');

      const page = analyzeFile(
        `${root}/src/app/dashboard/(shell)/company/[id]/page.tsx`,
        'src/app/dashboard/(shell)/company/[id]/page.tsx'
      ).symbols[0];
      expect(page).toMatchObject({
        kind: 'route',
        name: 'CompanyPage',
        route: '/dashboard/company/:id',
      });
      expect(page.role).toContain('page');

      const handler = analyzeFile(`${root}/src/app/api/health/route.ts`, 'src/app/api/health/route.ts')
        .symbols[0];
      expect(handler).toMatchObject({ kind: 'route', name: 'GET', route: 'GET /api/health' });
    } finally {
      cleanup(root);
    }
  });

  it('records each tRPC procedure as its own symbol', () => {
    const root = makeProject({});
    try {
      writeFile(
        root,
        'src/server/router.ts',
        `import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "./trpc";

export const companyRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx }) => ctx.db.company.findMany()),
  updateTier: protectedProcedure
    .input(z.object({ ids: z.array(z.string()), tier: z.number() }))
    .mutation(async ({ ctx, input }) => ctx.db.company.updateMany(input)),
});
`
      );
      const { symbols } = analyzeFile(`${root}/src/server/router.ts`, 'src/server/router.ts');
      const names = symbols.map((s) => `${s.kind}:${s.name}`);
      expect(names).toEqual([
        'const:companyRouter',
        'procedure:companyRouter.list',
        'procedure:companyRouter.updateTier',
      ]);

      const updateTier = symbols[2];
      expect(updateTier.members).toEqual(['ids', 'tier']);
      expect(updateTier.role).toEqual(['mutation', 'protected']);
      // Procedures inherit the router's visibility
      expect(updateTier.export).toBe('named');
      expect(symbols[0].members).toEqual(['list', 'updateTier']);
    } finally {
      cleanup(root);
    }
  });

  it('records a handler exported under method aliases as one route per method', () => {
    const root = makeProject({});
    try {
      const rel = 'src/app/api/trpc/[trpc]/route.ts';
      writeFile(
        root,
        rel,
        `import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

const handler = (req: Request) => fetchRequestHandler({ endpoint: "/api/trpc", req });

export { handler as GET, handler as POST };
`
      );
      const analysis = analyzeFile(`${root}/${rel}`, rel);
      const byName = new Map(analysis.symbols.map((s) => [s.name, s]));
      expect(byName.get('GET')).toMatchObject({
        kind: 'route',
        route: 'GET /api/trpc/:trpc',
        export: 'named',
        edges: [{ kind: 'references', name: 'handler' }],
      });
      expect(byName.get('POST')).toMatchObject({ kind: 'route', route: 'POST /api/trpc/:trpc' });
      expect(byName.get('GET')?.role).toContain('api');
      // The routes share the handler's body, so editing it changes both
      expect(byName.get('GET')?.bodyHash).toBe(byName.get('handler')?.bodyHash);
      expect(analysis.exportAliases).toEqual([
        { exported: 'GET', local: 'handler' },
        { exported: 'POST', local: 'handler' },
      ]);

      const { symbols } = linkSymbols(root, [analysis]);
      const get = symbols.find((s) => s.name === 'GET');
      expect(get?.edges[0].id).toBe(`${rel}#handler`);
    } finally {
      cleanup(root);
    }
  });

  it('records handlers imported or re-exported into a route file', () => {
    const root = makeProject({});
    try {
      writeFile(
        root,
        'src/server/auth.ts',
        'export function GET() {\n  return new Response();\n}\nexport function authPost() {\n  return new Response();\n}\n'
      );
      writeFile(
        root,
        'src/app/api/auth/route.ts',
        'export { GET, authPost as POST } from "../../../server/auth";\n'
      );
      writeFile(
        root,
        'src/app/api/session/route.ts',
        'import { GET } from "../../../server/auth";\nexport { GET };\n'
      );
      const files = ['src/server/auth.ts', 'src/app/api/auth/route.ts', 'src/app/api/session/route.ts'];
      const analyses = files.map((f) => analyzeFile(`${root}/${f}`, f));
      const { symbols } = linkSymbols(root, analyses);
      const route = (file: string, name: string) =>
        symbols.find((s) => s.file === file && s.name === name);

      expect(route('src/app/api/auth/route.ts', 'GET')).toMatchObject({
        kind: 'route',
        route: 'GET /api/auth',
      });
      expect(route('src/app/api/auth/route.ts', 'GET')?.edges[0].id).toBe('src/server/auth.ts#GET');
      expect(route('src/app/api/auth/route.ts', 'POST')?.edges[0].id).toBe(
        'src/server/auth.ts#authPost'
      );
      expect(route('src/app/api/session/route.ts', 'GET')).toMatchObject({
        kind: 'route',
        route: 'GET /api/session',
      });
      expect(route('src/app/api/session/route.ts', 'GET')?.edges[0].id).toBe(
        'src/server/auth.ts#GET'
      );
    } finally {
      cleanup(root);
    }
  });
});
