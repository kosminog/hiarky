import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import fg from 'fast-glob';
import * as yaml from 'js-yaml';
import { analyzeFile } from './analyze';
import { findProjectRoot, readGitInfo, readProjectName } from './project';
import { linkComponents } from './resolve';
import { FileAnalysis, Snapshot } from './types';

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

export async function runSnap(): Promise<void> {
  const root = findProjectRoot(process.cwd());
  if (!root) {
    console.error('hiarky: no package.json found in this directory or any parent.');
    process.exitCode = 1;
    return;
  }

  console.log(`Scanning ${root} ...`);
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

  const now = new Date();
  const snapshot: Snapshot = {
    hiarky: 1,
    id: randomUUID(),
    timestamp: now.toISOString(),
    project: { root, name: readProjectName(root) },
    git: readGitInfo(root),
    stats: { files: files.length, components: components.length },
    components,
    roots,
    ...(errors.length > 0 ? { errors } : {}),
  };

  const dir = snapshotsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  // Filesystem-safe timestamp: 2026-08-13T14-35-02-123Z
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}-${snapshot.id}.snapshot`);
  fs.writeFileSync(file, yaml.dump(snapshot, { lineWidth: 120, noRefs: true }));

  console.log(
    `Snapped ${components.length} component${components.length === 1 ? '' : 's'} ` +
      `across ${analyses.length} file${analyses.length === 1 ? '' : 's'} ` +
      `(${files.length} scanned).`
  );
  if (snapshot.git) {
    console.log(
      `Commit ${snapshot.git.commit.slice(0, 7)} on ${snapshot.git.branch}` +
        (snapshot.git.dirty ? ' (dirty)' : '')
    );
  }
  if (errors.length > 0) {
    console.warn(`Warning: ${errors.length} file(s) failed to parse; recorded in the snapshot.`);
  }
  console.log(`Saved ${path.relative(process.cwd(), file)}`);
}

export function loadSnapshots(root: string): Snapshot[] {
  const dir = snapshotsDir(root);
  if (!fs.existsSync(dir)) return [];
  const snaps: Snapshot[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.snapshot')) continue;
    try {
      const doc = yaml.load(fs.readFileSync(path.join(dir, name), 'utf8')) as Snapshot;
      if (doc && doc.hiarky === 1) snaps.push(doc);
    } catch (err) {
      console.warn(`Skipping unreadable snapshot ${name}: ${err}`);
    }
  }
  snaps.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return snaps;
}
