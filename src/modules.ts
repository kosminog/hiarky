import * as fs from 'fs';
import * as path from 'path';
import fg from 'fast-glob';

const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs'];

/** One `paths` entry, pre-split around its single wildcard. */
interface PathMapping {
  /** Text before the "*", e.g. "~/" for "~/*" */
  prefix: string;
  /** Text after the "*", usually "" */
  suffix: string;
  /** Absolute target patterns, each still containing a "*" placeholder */
  targets: string[];
}

interface TsConfig {
  /** Directory the config lives in */
  dir: string;
  mappings: PathMapping[];
  /** Absolute baseUrl, when set */
  baseUrl: string | null;
}

interface WorkspacePackage {
  name: string;
  /** Absolute package directory */
  dir: string;
}

export interface ResolverContext {
  root: string;
  /** tsconfigs by directory, longest path first so the nearest one wins */
  tsconfigs: TsConfig[];
  packages: WorkspacePackage[];
}

/**
 * Parse JSON with comments and trailing commas — tsconfig.json is JSONC in
 * practice (the TypeScript-generated ones are full of /* *\/ section headers).
 */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i++;
      } else if (c === quote) {
        inString = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  // Trailing commas before } or ]
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

function readJsonc(file: string): Record<string, unknown> | null {
  try {
    const parsed = parseJsonc(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Resolve a tsconfig `extends` target: relative path, or a package under node_modules. */
function resolveExtends(fromDir: string, spec: string): string | null {
  const candidates = spec.startsWith('.')
    ? [path.resolve(fromDir, spec), path.resolve(fromDir, spec + '.json')]
    : [
        path.join(fromDir, 'node_modules', spec),
        path.join(fromDir, 'node_modules', spec + '.json'),
        path.join(fromDir, 'node_modules', spec, 'tsconfig.json'),
      ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** compilerOptions from a tsconfig, merged through its `extends` chain. */
function readCompilerOptions(file: string, seen = new Set<string>()): Record<string, unknown> {
  if (seen.has(file)) return {};
  seen.add(file);
  const json = readJsonc(file);
  if (!json) return {};
  const own = (json.compilerOptions as Record<string, unknown>) ?? {};
  const ext = json.extends;
  const parents = typeof ext === 'string' ? [ext] : Array.isArray(ext) ? ext : [];
  let inherited: Record<string, unknown> = {};
  for (const spec of parents) {
    if (typeof spec !== 'string') continue;
    const parentFile = resolveExtends(path.dirname(file), spec);
    if (parentFile) inherited = { ...inherited, ...readCompilerOptions(parentFile, seen) };
  }
  return { ...inherited, ...own };
}

function loadTsConfig(file: string): TsConfig | null {
  const opts = readCompilerOptions(file);
  const dir = path.dirname(file);
  const baseUrl = typeof opts.baseUrl === 'string' ? path.resolve(dir, opts.baseUrl) : null;
  const rawPaths = (opts.paths as Record<string, unknown>) ?? {};
  const mappings: PathMapping[] = [];
  // `paths` are relative to baseUrl when set, otherwise to the config itself
  const pathsBase = baseUrl ?? dir;
  for (const [pattern, targets] of Object.entries(rawPaths)) {
    if (!Array.isArray(targets)) continue;
    const star = pattern.indexOf('*');
    const prefix = star === -1 ? pattern : pattern.slice(0, star);
    const suffix = star === -1 ? '' : pattern.slice(star + 1);
    mappings.push({
      prefix,
      suffix,
      targets: targets
        .filter((t): t is string => typeof t === 'string')
        .map((t) => path.resolve(pathsBase, t)),
    });
  }
  if (!baseUrl && mappings.length === 0) return null;
  return { dir, baseUrl, mappings };
}

/** Workspace globs from package.json#workspaces and pnpm-workspace.yaml. */
function workspaceGlobs(root: string): string[] {
  const globs: string[] = [];
  const pkg = readJsonc(path.join(root, 'package.json'));
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) globs.push(...ws.filter((g): g is string => typeof g === 'string'));
  else if (ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)) {
    globs.push(
      ...((ws as { packages: unknown[] }).packages.filter(
        (g): g is string => typeof g === 'string'
      ))
    );
  }
  // pnpm-workspace.yaml: only the `packages:` list matters, and it is a flat
  // list of quoted globs — parsed directly to avoid loading yaml here.
  const pnpmFile = path.join(root, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmFile)) {
    let inPackages = false;
    for (const line of fs.readFileSync(pnpmFile, 'utf8').split('\n')) {
      if (/^packages:\s*$/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        const m = /^\s*-\s*["']?([^"'#]+?)["']?\s*$/.exec(line);
        if (m) globs.push(m[1]);
        else if (/^\S/.test(line)) inPackages = false;
      }
    }
  }
  return globs;
}

function loadPackages(root: string): WorkspacePackage[] {
  const globs = workspaceGlobs(root);
  if (globs.length === 0) return [];
  const manifests = fg.sync(
    globs.map((g) => `${g.replace(/\/$/, '')}/package.json`),
    { cwd: root, absolute: true, ignore: ['**/node_modules/**'] }
  );
  const packages: WorkspacePackage[] = [];
  for (const file of manifests) {
    const json = readJsonc(file);
    if (json && typeof json.name === 'string') {
      packages.push({ name: json.name, dir: path.dirname(file) });
    }
  }
  return packages;
}

/**
 * Discover every path alias and workspace package in a project, once per scan.
 * Without this a monorepo's internal imports ("~/components/ui/button",
 * "@acme/web/thing") all look like third-party packages and the graph falls apart.
 */
export function loadResolverContext(root: string): ResolverContext {
  const configFiles = fg.sync(['**/tsconfig*.json', '**/jsconfig.json'], {
    cwd: root,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**'],
  });
  const tsconfigs: TsConfig[] = [];
  for (const file of configFiles) {
    const cfg = loadTsConfig(file);
    if (cfg) tsconfigs.push(cfg);
  }
  // Nearest config wins: deepest directory first
  tsconfigs.sort((a, b) => b.dir.length - a.dir.length);
  return { root, tsconfigs, packages: loadPackages(root) };
}

/** Does this absolute path (possibly extensionless) point at a source file? */
function existingFile(base: string): string | null {
  const tries = [
    base,
    ...EXTENSIONS.map((e) => base + e),
    ...EXTENSIONS.map((e) => path.join(base, 'index' + e)),
  ];
  for (const p of tries) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

function inProject(root: string, abs: string): string | null {
  const rel = path.relative(root, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
}

/** The nearest tsconfig above a file, if any. */
function configFor(ctx: ResolverContext, fromFile: string): TsConfig | undefined {
  const dir = path.resolve(ctx.root, path.dirname(fromFile));
  return ctx.tsconfigs.find((c) => dir === c.dir || dir.startsWith(c.dir + path.sep));
}

/**
 * Resolve an import specifier to a project-relative file path, or null when it
 * points outside the project (a real third-party package).
 *
 * Tries, in order: relative paths, tsconfig `paths` aliases, tsconfig baseUrl,
 * then workspace package names.
 */
export function resolveSpecifier(
  ctx: ResolverContext,
  fromFile: string,
  source: string
): string | null {
  if (source.startsWith('.')) {
    const abs = existingFile(path.resolve(ctx.root, path.dirname(fromFile), source));
    return abs ? inProject(ctx.root, abs) : null;
  }

  const cfg = configFor(ctx, fromFile);
  if (cfg) {
    for (const m of cfg.mappings) {
      if (!source.startsWith(m.prefix) || !source.endsWith(m.suffix)) continue;
      const stem = source.slice(m.prefix.length, source.length - (m.suffix.length || 0));
      for (const target of m.targets) {
        const abs = existingFile(target.includes('*') ? target.replace('*', stem) : target);
        const rel = abs && inProject(ctx.root, abs);
        if (rel) return rel;
      }
    }
    if (cfg.baseUrl) {
      const abs = existingFile(path.resolve(cfg.baseUrl, source));
      const rel = abs && inProject(ctx.root, abs);
      if (rel) return rel;
    }
  }

  for (const pkg of ctx.packages) {
    if (source !== pkg.name && !source.startsWith(pkg.name + '/')) continue;
    const sub = source.slice(pkg.name.length).replace(/^\//, '');
    const bases = sub ? [path.join(pkg.dir, sub), path.join(pkg.dir, 'src', sub)] : [pkg.dir];
    if (!sub) {
      const manifest = readJsonc(path.join(pkg.dir, 'package.json'));
      for (const field of ['module', 'main'] as const) {
        const v = manifest?.[field];
        if (typeof v === 'string') bases.unshift(path.resolve(pkg.dir, v));
      }
      bases.push(path.join(pkg.dir, 'src'));
    }
    for (const base of bases) {
      const abs = existingFile(base);
      const rel = abs && inProject(ctx.root, abs);
      if (rel) return rel;
    }
  }

  return null;
}
