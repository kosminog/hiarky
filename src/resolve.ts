import {
  loadResolverContext,
  ResolveOptions,
  ResolverContext,
  resolveSpecifier,
} from './modules';
import { schemaFields } from './extractors/frameworks';
import { FileAnalysis, isRenderable, SymbolInfo } from './types';

const MAX_BARREL_DEPTH = 8;

/** Python resolves bare module paths against its package root; JS does not. */
function resolveOptionsFor(file: string): ResolveOptions {
  return file.endsWith('.py') ? { packageRelative: true } : {};
}

/**
 * Where a module's exported name ends up: a project symbol, or a module
 * specifier outside the project when a barrel re-exports a package.
 */
type ExportTarget = { symbol: SymbolInfo } | { external: string } | undefined;

/**
 * Link edges to concrete symbol ids using each file's imports, then compute
 * root components (components nothing else renders).
 *
 * Import specifiers are resolved through tsconfig path aliases and workspace
 * packages, and barrel files are followed, so a monorepo's internal imports
 * link up instead of being written off as third-party packages.
 */
export function linkSymbols(
  root: string,
  analyses: FileAnalysis[],
  ctx: ResolverContext = loadResolverContext(root)
): { symbols: SymbolInfo[]; roots: string[] } {
  const byFileAndName = new Map<string, SymbolInfo>();
  const byName = new Map<string, SymbolInfo[]>();
  const defaultOfFile = new Map<string, SymbolInfo>();
  const analysisOfFile = new Map<string, FileAnalysis>();

  for (const a of analyses) {
    analysisOfFile.set(a.file, a);
    for (const s of a.symbols) {
      byFileAndName.set(`${s.file}#${s.name}`, s);
      const list = byName.get(s.name) ?? [];
      list.push(s);
      byName.set(s.name, list);
      if (s.export === 'default') defaultOfFile.set(s.file, s);
    }
  }

  /**
   * Find the symbol a module exports under `name`, following `export ... from`
   * chains so barrel files are transparent.
   */
  const findExport = (
    file: string,
    name: string,
    depth = 0,
    seen = new Set<string>()
  ): ExportTarget => {
    const key = `${file}#${name}`;
    if (depth > MAX_BARREL_DEPTH || seen.has(key)) return undefined;
    seen.add(key);

    const direct =
      name === 'default' ? defaultOfFile.get(file) : byFileAndName.get(`${file}#${name}`);
    if (direct) return { symbol: direct };

    const analysis = analysisOfFile.get(file);
    if (!analysis) return undefined;

    // `export { inner as outer }` of a local declaration
    const alias = analysis.exportAliases?.find((a) => a.exported === name);
    const aliased = alias && byFileAndName.get(`${file}#${alias.local}`);
    if (aliased) return { symbol: aliased };

    return followReexports(analysis, name, depth, seen);
  };

  /** Where `export … from` bindings in one file send `name`. */
  const followReexports = (
    analysis: FileAnalysis,
    name: string,
    depth = 0,
    seen = new Set<string>()
  ): ExportTarget => {
    const file = analysis.file;
    let external: string | undefined;
    for (const re of analysis.reexports) {
      if (re.exported !== name && re.exported !== '*') continue;
      const target = resolveSpecifier(ctx, file, re.source, resolveOptionsFor(file));
      if (!target) {
        // The chain leaves the project here (`export { cn } from "cn"`);
        // remember the true origin but keep looking for a project symbol.
        external ??= re.source;
        continue;
      }
      // `export * from './x'` forwards the name unchanged; a named re-export
      // may rename it (`export { inner as outer }`).
      const nextName = re.exported === '*' ? name : re.imported;
      const found = findExport(target, nextName, depth + 1, seen);
      if (found && 'symbol' in found) return found;
      if (found && 'external' in found) external ??= found.external;
    }
    return external ? { external } : undefined;
  };

  const rendered = new Set<string>();

  for (const a of analyses) {
    const importByLocal = new Map(a.imports.map((i) => [i.local, i]));
    for (const sym of a.symbols) {
      for (const edge of sym.edges) {
        const head = edge.name.split('.')[0];
        const imp = importByLocal.get(head);

        let target: SymbolInfo | undefined;
        if (imp) {
          const resolvedFile = resolveSpecifier(ctx, a.file, imp.source, resolveOptionsFor(a.file));
          if (resolvedFile) {
            const wanted =
              imp.imported === '*' ? (edge.name.split('.')[1] ?? 'default') : imp.imported;
            const found = findExport(resolvedFile, wanted);
            if (found && 'symbol' in found) target = found.symbol;
            else target = defaultOfFile.get(resolvedFile);
            if (!target) {
              edge.external = found && 'external' in found ? found.external : imp.source;
            }
          } else {
            edge.external = imp.source; // genuine package import
          }
        } else if (a.reexports.some((re) => re.exported === head)) {
          // A route re-exporting its handler (`export { GET } from './h'`)
          // references it by the name it forwards.
          const found = followReexports(a, head);
          if (found && 'symbol' in found) target = found.symbol;
          else if (found) edge.external = found.external;
        } else {
          // Not imported: same-file symbol, or an unresolved global
          target = byFileAndName.get(`${a.file}#${head}`) ?? byName.get(head)?.[0];
        }

        if (target) {
          edge.id = target.id;
          if (edge.kind === 'renders' && target.id !== sym.id) rendered.add(target.id);
        }
      }
    }
  }

  const resolveFile = (file: string, source: string) =>
    resolveSpecifier(ctx, file, source, resolveOptionsFor(file));
  resolveSchemas(analyses, byFileAndName, resolveFile, findExport);

  const symbols = analyses.flatMap((a) => a.symbols).sort((x, y) => x.id.localeCompare(y.id));
  const roots = symbols
    .filter((s) => isRenderable(s.kind) && !rendered.has(s.id))
    .map((s) => s.id);
  return { symbols, roots };
}

/**
 * Expand schemas built from declarations elsewhere — `.input(listSchema)`,
 * `filterSchema.extend({ … })`, `z.object(filterShape)` — into the fields
 * they end up with, following imports and barrels the way edges do.
 */
function resolveSchemas(
  analyses: FileAnalysis[],
  byFileAndName: Map<string, SymbolInfo>,
  resolveFile: (fromFile: string, source: string) => string | null,
  findExport: (file: string, name: string) => ExportTarget
): void {
  const importsOf = new Map(
    analyses.map((a) => [a.file, new Map(a.imports.map((i) => [i.local, i]))])
  );

  /** The declaration a schema reference names, if it is in the project. */
  const lookup = (file: string, name: string): SymbolInfo | undefined => {
    const [head, ...rest] = name.split('.');
    const imp = importsOf.get(file)?.get(head);
    if (!imp) {
      // A property of a local object is not a declaration of its own
      return rest.length ? undefined : byFileAndName.get(`${file}#${head}`);
    }
    // `import * as schemas` makes `schemas.list` an export of that module
    const wanted = imp.imported === '*' ? rest[0] : imp.imported;
    if (!wanted || rest.length > (imp.imported === '*' ? 1 : 0)) return undefined;
    const target = resolveFile(file, imp.source);
    const found = target ? findExport(target, wanted) : undefined;
    return found && 'symbol' in found ? found.symbol : undefined;
  };

  const resolved = new Map<string, string[]>();
  const inProgress = new Set<string>();
  const fieldsOf = (sym: SymbolInfo): string[] | null => {
    const done = resolved.get(sym.id);
    if (done) return done;
    if (!sym.schema) return sym.members ?? [];
    if (inProgress.has(sym.id)) return null; // a cycle expands to nothing
    inProgress.add(sym.id);
    const shape = sym.schema;
    const fields = schemaFields(shape, (name) => {
      const target = lookup(sym.file, name);
      return target ? fieldsOf(target) : null;
    });
    inProgress.delete(sym.id);
    resolved.set(sym.id, fields);
    return fields;
  };

  const withSchemas = analyses.flatMap((a) => a.symbols.filter((s) => s.schema));
  for (const sym of withSchemas) fieldsOf(sym);
  for (const sym of withSchemas) {
    const fields = resolved.get(sym.id) ?? [];
    if (fields.length) sym.members = fields;
    else delete sym.members;
    delete sym.schema;
  }
}
