/** Source language of a symbol, derived from the extractor that produced it. */
export type Lang =
  | 'js'
  | 'jsx'
  | 'ts'
  | 'tsx'
  | 'py'
  | 'prisma'
  | 'sql'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'env'
  // Covered by the generic declaration scanner
  | 'go'
  | 'rust'
  | 'java'
  | 'kotlin'
  | 'csharp'
  | 'swift'
  | 'php'
  | 'sh';

/**
 * What a symbol is. Kept deliberately coarse: extractors for other languages
 * and file formats reuse these, adding new members only when a reviewer would
 * read the distinction differently (a route change is not a function change).
 */
export type SymbolKind =
  | 'component'
  | 'function'
  | 'class'
  | 'method'
  | 'type'
  | 'const'
  /** An HTTP-addressable entry point: a Next.js page or route handler */
  | 'route'
  /** One tRPC procedure on a router */
  | 'procedure'
  /** A database model or table */
  | 'model'
  /** A database migration */
  | 'migration'
  /** A block of project configuration: scripts, dependencies, env keys */
  | 'config'
  /** A whole file, when it could not be analyzed in more detail */
  | 'module'
  /** A test suite, with its cases as members */
  | 'test';

/** Kinds that describe declared data or configuration rather than code. */
export const DECLARATIVE_KINDS: SymbolKind[] = ['model', 'migration', 'config'];

/** How one symbol depends on another. */
export type EdgeKind = 'renders' | 'calls' | 'extends' | 'references';

export interface HookUsage {
  /** Hook function name, e.g. "useState", "useCustomThing" */
  name: string;
  /** Extra context, e.g. the state variable name for useState */
  detail?: string;
}

export interface Edge {
  kind: EdgeKind;
  /** Identifier as written at the use site, e.g. "Button" or "Ctx.Provider" */
  name: string;
  /** Resolved symbol id if the name maps to a project symbol */
  id?: string;
  /** Module specifier when the target lives outside the project */
  external?: string;
}

export interface SymbolInfo {
  /** Stable id: "<relative file>#<symbol name>" */
  id: string;
  name: string;
  file: string;
  lang: Lang;
  kind: SymbolKind;
  export: 'default' | 'named' | 'none';
  /** Coarse tags a reviewer filters by, e.g. "client" / "server" */
  role?: string[];
  /** Normalized parameter/return text for functions */
  signature?: string;
  /** URL this symbol serves, for routes: "/dashboard/:id" or "GET /api/health" */
  route?: string;
  /** Props, type members, class members — whatever this symbol exposes */
  members?: string[];
  /** React facet: hooks called in the body */
  hooks?: HookUsage[];
  edges: Edge[];
  /** Hash of the declaration's source, for move/rename detection */
  bodyHash: string;
}

/**
 * Kinds that sit in the render tree. A Next.js page is recorded as a route,
 * but it still renders components and still belongs at the top of the tree.
 */
export function isRenderable(kind: SymbolKind): boolean {
  return kind === 'component' || kind === 'route';
}

/** Edges of one kind, in declaration order. */
export function edgesOf(s: SymbolInfo, kind: EdgeKind): Edge[] {
  return s.edges.filter((e) => e.kind === kind);
}

export interface ImportBinding {
  /** Local identifier the import is bound to */
  local: string;
  /** Exported name at the source ("default" for default imports, "*" for namespace) */
  imported: string;
  /** Module specifier as written */
  source: string;
}

/**
 * `export { A } from './x'` / `export * from './x'` — the links that make
 * barrel files transparent to the resolver.
 */
export interface ReexportBinding {
  /** Name this module exposes ("*" for a star re-export) */
  exported: string;
  /** Name at the source ("*" for a star re-export, "default" for a default) */
  imported: string;
  source: string;
}

/** `export { handler as GET }` — a local declaration exposed under another name. */
export interface ExportAlias {
  /** Name this module exposes */
  exported: string;
  /** Local identifier it is bound to */
  local: string;
}

export interface FileAnalysis {
  file: string;
  symbols: SymbolInfo[];
  imports: ImportBinding[];
  reexports: ReexportBinding[];
  /** Local declarations exported under a different name */
  exportAliases?: ExportAlias[];
  parseError?: string;
}

export interface GitInfo {
  commit: string;
  branch: string;
  dirty: boolean;
}

export const SNAPSHOT_VERSION = 2;

export interface Snapshot {
  hiarky: number;
  id: string;
  timestamp: string;
  project: {
    root: string;
    name: string;
  };
  git: GitInfo | null;
  stats: {
    files: number;
    symbols: number;
    components: number;
  };
  symbols: SymbolInfo[];
  /** Component ids never rendered by another project component */
  roots: string[];
  /** sha256 of symbols + roots, used to skip identical snapshots */
  contentHash?: string;
  /** Files that could not be parsed */
  errors?: { file: string; message: string }[];
}
