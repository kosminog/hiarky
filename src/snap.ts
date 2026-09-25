import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import fg from 'fast-glob';
import * as yaml from 'js-yaml';
import { AnalysisCache, contentKeys, nullCache, openCache } from './cache';
import { Extractor, extractorFor, extractorGlobs } from './extractors';
import { isTestFile } from './extractors/tests';
import { loadResolverContext } from './modules';
import { findProjectRoot, listGitFiles, readGitInfo, readProjectName } from './project';
import { linkSymbols } from './resolve';
import {
  FileAnalysis,
  GitInfo,
  isRenderable,
  Snapshot,
  SNAPSHOT_VERSION,
  SymbolInfo,
} from './types';

const IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.hiarky/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/coverage/**',
  '**/generated/**',
  '**/.turbo/**',
  '**/vendor/**',
  '**/*.min.js',
  '**/*.d.ts',
];

export function snapshotsDir(root: string): string {
  return path.join(root, '.hiarky', 'snapshots');
}

export interface ProjectAnalysis {
  filesScanned: number;
  filesWithSymbols: number;
  symbols: SymbolInfo[];
  roots: string[];
  errors: { file: string; message: string }[];
}

export function componentsOf(symbols: SymbolInfo[]): SymbolInfo[] {
  return symbols.filter((s) => isRenderable(s.kind));
}

export interface AnalyzeOptions {
  /**
   * Reuse per-file results across scans. Supply a cache anchored at the real
   * project root when scanning a checkout elsewhere (a backfill worktree).
   */
  cache?: AnalysisCache;
}

/** Scan and analyze a project directory. Pure: no snapshot is written. */
export async function analyzeProject(
  root: string,
  opts: AnalyzeOptions = {}
): Promise<ProjectAnalysis> {
  // dot: true so `.env.example` is visible; `.git` is excluded above
  const globbed = await fg(extractorGlobs(), {
    cwd: root,
    ignore: IGNORE,
    absolute: false,
    dot: true,
  });
  // In a git repository, ignored files are build output by definition
  const gitFiles = listGitFiles(root);
  const files = (gitFiles ? globbed.filter((f) => gitFiles.has(f)) : globbed).sort();

  const cache = opts.cache ?? nullCache();
  // Fingerprints are only worth computing when something will use them
  const keys = opts.cache ? contentKeys(root, files) : new Map<string, string>();

  // Group by extractor so batch-capable ones (Python spawns an interpreter)
  // are invoked once rather than once per file.
  const groups = new Map<Extractor, Array<{ abs: string; rel: string }>>();
  const results: FileAnalysis[] = [];

  for (const rel of files) {
    const extractor = extractorFor(rel);
    if (!extractor) continue;
    const cached = cache.get(extractor.name, rel, keys.get(rel));
    if (cached) {
      results.push(cached);
      continue;
    }
    const group = groups.get(extractor) ?? [];
    group.push({ abs: path.join(root, rel), rel });
    groups.set(extractor, group);
  }

  for (const [extractor, group] of groups) {
    const fresh = extractor.analyzeMany
      ? extractor.analyzeMany(group)
      : group.map((f) => extractor.analyze(f.abs, f.rel));
    for (const analysis of fresh) {
      cache.set(extractor.name, analysis.file, keys.get(analysis.file), analysis);
      results.push(analysis);
    }
  }
  results.sort((a, b) => a.file.localeCompare(b.file));

  // One place, every language: anything declared in a test file is test code
  for (const analysis of results) {
    if (!isTestFile(analysis.file)) continue;
    for (const symbol of analysis.symbols) {
      if (!symbol.role?.includes('test')) symbol.role = [...(symbol.role ?? []), 'test'];
    }
  }

  const analyses: FileAnalysis[] = [];
  const errors: { file: string; message: string }[] = [];
  for (const analysis of results) {
    if (analysis.parseError) errors.push({ file: analysis.file, message: analysis.parseError });
    if (analysis.symbols.length > 0 || analysis.reexports.length > 0) analyses.push(analysis);
  }

  const { symbols, roots } = linkSymbols(root, analyses, loadResolverContext(root));
  return {
    filesScanned: files.length,
    filesWithSymbols: analyses.filter((a) => a.symbols.length > 0).length,
    symbols,
    roots,
    errors,
  };
}

export function contentHashOf(symbols: SymbolInfo[], roots: string[]): string {
  // A comment added above a function moves every line after it; that is not
  // a change worth a snapshot.
  const content = symbols.map(({ line: _line, ...rest }) => rest);
  return createHash('sha256').update(JSON.stringify({ symbols: content, roots })).digest('hex');
}

/** Hash of a snapshot's content, computed on the fly for pre-hash snapshots. */
export function snapshotHash(s: Snapshot): string {
  return s.contentHash ?? contentHashOf(s.symbols, s.roots);
}

export function buildSnapshot(
  analysis: ProjectAnalysis,
  opts: { root: string; name: string; git: GitInfo | null; timestamp: Date; id?: string }
): Snapshot {
  return {
    hiarky: SNAPSHOT_VERSION,
    id: opts.id ?? randomUUID(),
    timestamp: opts.timestamp.toISOString(),
    project: { root: opts.root, name: opts.name },
    git: opts.git,
    stats: {
      files: analysis.filesScanned,
      symbols: analysis.symbols.length,
      components: componentsOf(analysis.symbols).length,
    },
    symbols: analysis.symbols,
    roots: analysis.roots,
    contentHash: contentHashOf(analysis.symbols, analysis.roots),
    ...(analysis.errors.length > 0 ? { errors: analysis.errors } : {}),
  };
}

/** Write a snapshot into <root>/.hiarky/snapshots and return the file path. */
export function writeSnapshot(root: string, snapshot: Snapshot): string {
  const dir = snapshotsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  // Filesystem-safe timestamp: 2026-08-13T14-35-02-123Z
  const stamp = snapshot.timestamp.replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}-${snapshot.id}.snapshot`);
  fs.writeFileSync(file, yaml.dump(snapshot, { lineWidth: 120, noRefs: true }));
  return file;
}

export interface SnapshotEntry {
  file: string;
  snapshot: Snapshot;
}

/**
 * Bring a pre-symbol (hiarky: 1) snapshot forward: its components become
 * symbols of kind 'component', props become members, renders become edges.
 * Old snapshots stay readable so an existing history keeps working.
 */
export function upgradeSnapshot(doc: Record<string, unknown>): Snapshot | null {
  if (doc.hiarky === SNAPSHOT_VERSION) return doc as unknown as Snapshot;
  if (doc.hiarky !== 1) return null;

  const legacy = doc as unknown as {
    components: Array<{
      id: string;
      name: string;
      file: string;
      kind: string;
      export: SymbolInfo['export'];
      props?: string[];
      hooks?: SymbolInfo['hooks'];
      renders?: Array<{ name: string; id?: string; external?: string }>;
    }>;
    stats: { files: number; components: number };
  };

  const symbols: SymbolInfo[] = (legacy.components ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    file: c.file,
    lang: c.file.endsWith('.tsx')
      ? 'tsx'
      : c.file.endsWith('.ts')
        ? 'ts'
        : c.file.endsWith('.jsx')
          ? 'jsx'
          : 'js',
    kind: 'component',
    export: c.export,
    ...(c.props && c.props.length ? { members: c.props } : {}),
    ...(c.hooks && c.hooks.length ? { hooks: c.hooks } : {}),
    edges: (c.renders ?? []).map((r) => ({
      kind: 'renders' as const,
      name: r.name,
      ...(r.id ? { id: r.id } : {}),
      ...(r.external ? { external: r.external } : {}),
    })),
    // Pre-v2 snapshots carry no body hashes; an empty one compares equal to
    // itself, so upgraded history never shows phantom changes.
    bodyHash: '',
  }));

  return {
    ...(doc as unknown as Snapshot),
    hiarky: SNAPSHOT_VERSION,
    stats: {
      files: legacy.stats?.files ?? 0,
      symbols: symbols.length,
      components: symbols.length,
    },
    symbols,
    // A v1 contentHash was computed over the old shape; drop it so the
    // upgraded snapshot rehashes from its symbols.
    contentHash: undefined,
  };
}

/** All snapshots with their file paths, sorted oldest → newest. */
export function loadSnapshotEntries(root: string): SnapshotEntry[] {
  const dir = snapshotsDir(root);
  if (!fs.existsSync(dir)) return [];
  const entries: SnapshotEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.snapshot')) continue;
    const file = path.join(dir, name);
    try {
      const doc = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const snapshot = doc && typeof doc === 'object' ? upgradeSnapshot(doc) : null;
      if (snapshot) entries.push({ file, snapshot });
    } catch (err) {
      console.warn(`Skipping unreadable snapshot ${name}: ${err}`);
    }
  }
  entries.sort((a, b) => a.snapshot.timestamp.localeCompare(b.snapshot.timestamp));
  return entries;
}

export function loadSnapshots(root: string): Snapshot[] {
  return loadSnapshotEntries(root).map((e) => e.snapshot);
}

export interface SnapOptions {
  force?: boolean;
  quiet?: boolean;
  /** Skip the per-file analysis cache */
  noCache?: boolean;
}

/** Snapshot a project root. Returns true if a snapshot was written. */
export async function snapProject(root: string, opts: SnapOptions = {}): Promise<boolean> {
  const log = (msg: string) => {
    if (!opts.quiet) console.log(msg);
  };

  log(`Scanning ${root} ...`);
  const cache = opts.noCache ? nullCache() : openCache(root);
  const analysis = await analyzeProject(root, { cache });
  cache.flush();
  const snapshot = buildSnapshot(analysis, {
    root,
    name: readProjectName(root),
    git: readGitInfo(root),
    timestamp: new Date(),
  });

  if (!opts.force) {
    const entries = loadSnapshotEntries(root);
    const latest = entries[entries.length - 1];
    if (latest && snapshotHash(latest.snapshot) === snapshot.contentHash) {
      console.log(
        opts.quiet
          ? 'hiarky: no changes; snapshot skipped'
          : `No symbol changes since the last snapshot (${latest.snapshot.timestamp}); skipping. Use --force to snapshot anyway.`
      );
      return false;
    }
  }

  const file = writeSnapshot(root, snapshot);

  if (opts.quiet) {
    console.log(
      `hiarky: snapped ${snapshot.stats.symbols} symbols ` +
        `(${snapshot.stats.components} components) → ${path.basename(file)}`
    );
  } else {
    console.log(
      `Snapped ${snapshot.stats.symbols} symbol${snapshot.stats.symbols === 1 ? '' : 's'} ` +
        `(${snapshot.stats.components} component${snapshot.stats.components === 1 ? '' : 's'}) ` +
        `across ${analysis.filesWithSymbols} file${analysis.filesWithSymbols === 1 ? '' : 's'} ` +
        `(${analysis.filesScanned} scanned).`
    );
    if (snapshot.git) {
      console.log(
        `Commit ${snapshot.git.commit.slice(0, 7)} on ${snapshot.git.branch}` +
          (snapshot.git.dirty ? ' (dirty)' : '')
      );
    }
    if (analysis.errors.length > 0) {
      console.warn(
        `Warning: ${analysis.errors.length} file(s) failed to parse; recorded in the snapshot.`
      );
    }
    console.log(`Saved ${path.relative(process.cwd(), file)}`);
  }
  return true;
}
