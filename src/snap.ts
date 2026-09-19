import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import fg from 'fast-glob';
import * as yaml from 'js-yaml';
import { analyzeFile } from './analyze';
import { findProjectRoot, readGitInfo, readProjectName } from './project';
import { linkComponents } from './resolve';
import { ComponentInfo, FileAnalysis, GitInfo, Snapshot } from './types';

const SOURCE_GLOBS = ['**/*.{js,jsx,ts,tsx,mjs,cjs}'];
const IGNORE = [
  '**/node_modules/**',
  '**/.hiarky/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/coverage/**',
  '**/*.d.ts',
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/__mocks__/**',
];

export function snapshotsDir(root: string): string {
  return path.join(root, '.hiarky', 'snapshots');
}

export interface ProjectAnalysis {
  filesScanned: number;
  filesWithComponents: number;
  components: ComponentInfo[];
  roots: string[];
  errors: { file: string; message: string }[];
}

/** Scan and analyze a project directory. Pure: no snapshot is written. */
export async function analyzeProject(root: string): Promise<ProjectAnalysis> {
  const files = await fg(SOURCE_GLOBS, { cwd: root, ignore: IGNORE, absolute: false });
  files.sort();

  const analyses: FileAnalysis[] = [];
  const errors: { file: string; message: string }[] = [];
  for (const rel of files) {
    const analysis = analyzeFile(path.join(root, rel), rel);
    if (analysis.parseError) errors.push({ file: rel, message: analysis.parseError });
    if (analysis.components.length > 0) analyses.push(analysis);
  }

  const { components, roots } = linkComponents(root, analyses);
  return {
    filesScanned: files.length,
    filesWithComponents: analyses.length,
    components,
    roots,
    errors,
  };
}

export function contentHashOf(components: ComponentInfo[], roots: string[]): string {
  return createHash('sha256').update(JSON.stringify({ components, roots })).digest('hex');
}

/** Hash of a snapshot's content, computed on the fly for pre-hash snapshots. */
export function snapshotHash(s: Snapshot): string {
  return s.contentHash ?? contentHashOf(s.components, s.roots);
}

export function buildSnapshot(
  analysis: ProjectAnalysis,
  opts: { root: string; name: string; git: GitInfo | null; timestamp: Date; id?: string }
): Snapshot {
  return {
    hiarky: 1,
    id: opts.id ?? randomUUID(),
    timestamp: opts.timestamp.toISOString(),
    project: { root: opts.root, name: opts.name },
    git: opts.git,
    stats: { files: analysis.filesScanned, components: analysis.components.length },
    components: analysis.components,
    roots: analysis.roots,
    contentHash: contentHashOf(analysis.components, analysis.roots),
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

/** All snapshots with their file paths, sorted oldest → newest. */
export function loadSnapshotEntries(root: string): SnapshotEntry[] {
  const dir = snapshotsDir(root);
  if (!fs.existsSync(dir)) return [];
  const entries: SnapshotEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.snapshot')) continue;
    const file = path.join(dir, name);
    try {
      const doc = yaml.load(fs.readFileSync(file, 'utf8')) as Snapshot;
      if (doc && doc.hiarky === 1) entries.push({ file, snapshot: doc });
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
}

/** Snapshot a project root. Returns true if a snapshot was written. */
export async function snapProject(root: string, opts: SnapOptions = {}): Promise<boolean> {
  const log = (msg: string) => {
    if (!opts.quiet) console.log(msg);
  };

  log(`Scanning ${root} ...`);
  const analysis = await analyzeProject(root);
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
          ? 'hiarky: no component changes; snapshot skipped'
          : `No component changes since the last snapshot (${latest.snapshot.timestamp}); skipping. Use --force to snapshot anyway.`
      );
      return false;
    }
  }

  const file = writeSnapshot(root, snapshot);

  if (opts.quiet) {
    console.log(`hiarky: snapped ${snapshot.stats.components} components → ${path.basename(file)}`);
  } else {
    console.log(
      `Snapped ${snapshot.stats.components} component${snapshot.stats.components === 1 ? '' : 's'} ` +
        `across ${analysis.filesWithComponents} file${analysis.filesWithComponents === 1 ? '' : 's'} ` +
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
