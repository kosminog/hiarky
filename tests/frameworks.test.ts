import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { analyzeFile } from '../src/analyze';
import { isHttpMethod, routeFileInfo, trpcRouterOf } from '../src/extractors/frameworks';
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
      { key: 'list', operation: 'query', builder: 'protectedProcedure', input: [], node: expect.anything() },
      {
        key: 'create',
        operation: 'mutation',
        builder: 'protectedProcedure',
        input: ['name', 'tier'],
        node: expect.anything(),
      },
      { key: 'ping', operation: 'query', builder: 'publicProcedure', input: [], node: expect.anything() },
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
    expect(router?.procedures[0].input).toEqual(['id']);
  });

  it('returns null for anything that is not a router', () => {
    expect(routerFrom('const x = makeThing({ a: 1 });')).toBeNull();
    expect(routerFrom('const x = 5;')).toBeNull();
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
});
