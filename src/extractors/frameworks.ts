import * as path from 'path';
import * as t from '@babel/types';

/**
 * Framework-shaped declarations that a plain symbol table would flatten:
 * a Next.js page is not "a function called Page", it is the URL it serves,
 * and a tRPC router is not "a const" — it is a list of procedures with inputs.
 */

const ROUTE_FILES = new Set([
  'page',
  'route',
  'layout',
  'template',
  'default',
  'loading',
  'error',
  'not-found',
]);

const HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

export interface RouteFile {
  /** URL path the directory maps to, e.g. "/dashboard/company/:id" */
  urlPath: string;
  /** Which kind of special file this is: "page", "route", "layout", … */
  role: string;
}

/**
 * Map a Next.js App Router file to the URL it serves. Route groups `(shell)`
 * and parallel routes `@modal` do not appear in the URL; `[id]` becomes `:id`
 * and catch-alls become `*`.
 */
export function routeFileInfo(relFile: string): RouteFile | null {
  const ext = path.extname(relFile);
  if (!['.tsx', '.ts', '.jsx', '.js'].includes(ext)) return null;
  const base = path.basename(relFile, ext);
  if (!ROUTE_FILES.has(base)) return null;

  const segments = path.dirname(relFile).split('/');
  const appIndex = segments.lastIndexOf('app');
  if (appIndex === -1) return null;

  const parts: string[] = [];
  for (const seg of segments.slice(appIndex + 1)) {
    if (!seg) continue;
    if (seg.startsWith('(') && seg.endsWith(')')) continue; // route group
    if (seg.startsWith('@')) continue; // parallel route slot
    const optionalCatchAll = /^\[\[\.\.\.(.+)\]\]$/.exec(seg);
    if (optionalCatchAll) {
      parts.push(`*${optionalCatchAll[1]}?`);
      continue;
    }
    const catchAll = /^\[\.\.\.(.+)\]$/.exec(seg);
    if (catchAll) {
      parts.push(`*${catchAll[1]}`);
      continue;
    }
    const dynamic = /^\[(.+)\]$/.exec(seg);
    parts.push(dynamic ? `:${dynamic[1]}` : seg);
  }

  return { urlPath: '/' + parts.join('/'), role: base };
}

/** Is this exported name an HTTP handler in a `route.ts` file? */
export function isHttpMethod(name: string): boolean {
  return HTTP_METHODS.has(name);
}

export interface TrpcProcedure {
  /** Key on the router object */
  key: string;
  /** "query" | "mutation" | "subscription", when determinable */
  operation?: string;
  /** Procedure builder used, e.g. "protectedProcedure" */
  builder: string;
  /** Field names of the zod input schema */
  input: string[];
  /** The property value node, for hashing and body scanning */
  node: t.Node;
}

export interface TrpcRouter {
  procedures: TrpcProcedure[];
  /** Keys whose value is another router, by local identifier name */
  mounts: Array<{ key: string; name: string }>;
}

const ROUTER_FACTORIES = /(^|\.)(createTRPCRouter|router)$/;

function calleeChainName(node: t.Node): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node)) {
    const head = calleeChainName(node.object);
    return head && t.isIdentifier(node.property) ? `${head}.${node.property.name}` : head;
  }
  if (t.isCallExpression(node)) return calleeChainName(node.callee);
  return null;
}

/** Root identifier of a call chain: `protectedProcedure.input(…).query(…)`. */
function chainRoot(node: t.Node): string | null {
  const name = calleeChainName(node);
  return name ? name.split('.')[0] : null;
}

/** Every method called along a chain, outermost last. */
function chainMethods(node: t.Node): string[] {
  const methods: string[] = [];
  let cur: t.Node = node;
  while (t.isCallExpression(cur)) {
    if (t.isMemberExpression(cur.callee) && t.isIdentifier(cur.callee.property)) {
      methods.unshift(cur.callee.property.name);
      cur = cur.callee.object;
    } else break;
  }
  return methods;
}

/** Field names of the first `z.object({ … })` found under a node. */
function zodObjectKeys(node: t.Node): string[] {
  let found: string[] | null = null;
  const visit = (n: t.Node | null | undefined) => {
    if (!n || found) return;
    if (t.isCallExpression(n)) {
      const callee = calleeChainName(n.callee);
      if (callee && callee.endsWith('.object') && t.isObjectExpression(n.arguments[0])) {
        found = n.arguments[0].properties
          .map((p) =>
            (t.isObjectProperty(p) || t.isObjectMethod(p)) && t.isIdentifier(p.key)
              ? p.key.name
              : null
          )
          .filter((x): x is string => x !== null);
        return;
      }
      visit(n.callee);
      for (const arg of n.arguments) visit(arg as t.Node);
      return;
    }
    if (t.isMemberExpression(n)) {
      visit(n.object);
    }
  };
  visit(node);
  return found ?? [];
}

/** The argument of the `.input(…)` call in a procedure chain. */
function inputArgument(node: t.Node): t.Node | null {
  let cur: t.Node = node;
  while (t.isCallExpression(cur)) {
    if (
      t.isMemberExpression(cur.callee) &&
      t.isIdentifier(cur.callee.property, { name: 'input' }) &&
      cur.arguments.length > 0
    ) {
      return cur.arguments[0] as t.Node;
    }
    if (t.isMemberExpression(cur.callee)) cur = cur.callee.object;
    else break;
  }
  return null;
}

/**
 * Read a `createTRPCRouter({ … })` initializer into its procedures and the
 * sub-routers it mounts. Returns null when the initializer is not a router.
 */
export function trpcRouterOf(init: t.Node): TrpcRouter | null {
  if (!t.isCallExpression(init)) return null;
  const callee = calleeChainName(init.callee);
  if (!callee || !ROUTER_FACTORIES.test(callee)) return null;
  const arg = init.arguments[0];
  if (!t.isObjectExpression(arg)) return null;

  const procedures: TrpcProcedure[] = [];
  const mounts: Array<{ key: string; name: string }> = [];

  for (const prop of arg.properties) {
    if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key)) continue;
    const key = prop.key.name;
    const value = prop.value as t.Node;

    if (t.isIdentifier(value)) {
      mounts.push({ key, name: value.name });
      continue;
    }
    const root = chainRoot(value);
    if (!root || !/[Pp]rocedure$/.test(root)) continue;

    const methods = chainMethods(value);
    const operation = methods.find((m) => ['query', 'mutation', 'subscription'].includes(m));
    const inputArg = inputArgument(value);
    procedures.push({
      key,
      ...(operation ? { operation } : {}),
      builder: root,
      input: inputArg ? zodObjectKeys(inputArg) : [],
      node: value,
    });
  }

  return { procedures, mounts };
}
