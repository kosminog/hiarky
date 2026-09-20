import {
  loadResolverContext,
  ResolveOptions,
  ResolverContext,
  resolveSpecifier,
} from './modules';
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

  const symbols = analyses.flatMap((a) => a.symbols).sort((x, y) => x.id.localeCompare(y.id));
  const roots = symbols
    .filter((s) => isRenderable(s.kind) && !rendered.has(s.id))
    .map((s) => s.id);
  return { symbols, roots };
}
