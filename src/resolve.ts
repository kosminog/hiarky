import * as fs from 'fs';
import * as path from 'path';
import { ComponentInfo, FileAnalysis } from './types';

const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs'];

/** Resolve a relative import specifier to a project-relative file path, if it exists. */
function resolveModule(root: string, fromFile: string, source: string): string | null {
  const base = path.resolve(root, path.dirname(fromFile), source);
  const tries = [
    base,
    ...EXTENSIONS.map((e) => base + e),
    ...EXTENSIONS.map((e) => path.join(base, 'index' + e)),
  ];
  for (const p of tries) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return path.relative(root, p);
  }
  return null;
}

/**
 * Link `renders` entries to concrete component ids using each file's imports,
 * then compute root components (never rendered by another project component).
 */
export function linkComponents(
  root: string,
  analyses: FileAnalysis[]
): { components: ComponentInfo[]; roots: string[] } {
  const byFileAndName = new Map<string, ComponentInfo>();
  const byName = new Map<string, ComponentInfo[]>();
  const defaultOfFile = new Map<string, ComponentInfo>();

  for (const a of analyses) {
    for (const c of a.components) {
      byFileAndName.set(`${c.file}#${c.name}`, c);
      const list = byName.get(c.name) ?? [];
      list.push(c);
      byName.set(c.name, list);
      if (c.export === 'default') defaultOfFile.set(c.file, c);
    }
  }

  const rendered = new Set<string>();

  for (const a of analyses) {
    const importByLocal = new Map(a.imports.map((i) => [i.local, i]));
    for (const comp of a.components) {
      for (const child of comp.renders) {
        const head = child.name.split('.')[0];
        const imp = importByLocal.get(head);

        let target: ComponentInfo | undefined;
        if (imp) {
          const resolvedFile = imp.source.startsWith('.')
            ? resolveModule(root, a.file, imp.source)
            : null;
          if (resolvedFile) {
            target =
              imp.imported === 'default'
                ? defaultOfFile.get(resolvedFile) ??
                  byFileAndName.get(`${resolvedFile}#${head}`)
                : byFileAndName.get(`${resolvedFile}#${imp.imported}`) ??
                  defaultOfFile.get(resolvedFile);
          } else {
            child.external = imp.source; // package import (react-router-dom, etc.)
          }
        } else {
          // Not imported: same-file component, or unresolved global
          target = byFileAndName.get(`${a.file}#${head}`) ?? byName.get(head)?.[0];
        }

        if (target && target.id !== comp.id) {
          child.id = target.id;
          rendered.add(target.id);
        } else if (target && target.id === comp.id) {
          child.id = target.id; // recursive component
        }
      }
    }
  }

  const components = analyses
    .flatMap((a) => a.components)
    .sort((x, y) => x.id.localeCompare(y.id));
  const roots = components.filter((c) => !rendered.has(c.id)).map((c) => c.id);
  return { components, roots };
}
