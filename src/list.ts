import * as fs from 'fs';
import * as path from 'path';
import { diffSnapshots } from './diff';
import { findProjectRoot } from './project';
import { loadSnapshotEntries } from './snap';

export function runList(): void {
  const root = findProjectRoot(process.cwd());
  if (!root) {
    console.error('hiarky: no package.json found in this directory or any parent.');
    process.exitCode = 1;
    return;
  }
  const entries = loadSnapshotEntries(root);
  if (entries.length === 0) {
    console.log('No snapshots yet. Run `hiarky snap` first.');
    return;
  }

  const rows = entries.map((e, i) => {
    const s = e.snapshot;
    const when = s.timestamp.replace('T', ' ').slice(0, 19) + 'Z';
    const commit = s.git ? s.git.commit.slice(0, 7) + (s.git.dirty ? '*' : '') : '-';
    let changes = '';
    if (i > 0) {
      const d = diffSnapshots(entries[i - 1].snapshot, s);
      const parts = [];
      if (d.added.length) parts.push(`+${d.added.length}`);
      if (d.removed.length) parts.push(`-${d.removed.length}`);
      if (d.changed.length) parts.push(`~${d.changed.length}`);
      changes = parts.join(' ');
    }
    return {
      idx: String(i + 1),
      when,
      commit,
      components: String(s.stats.components),
      changes,
      id: s.id.slice(0, 8),
    };
  });

  const cols: Array<[keyof (typeof rows)[0], string]> = [
    ['idx', '#'],
    ['when', 'TIMESTAMP'],
    ['commit', 'COMMIT'],
    ['components', 'COMPONENTS'],
    ['changes', 'CHANGES'],
    ['id', 'ID'],
  ];
  const widths = cols.map(([key, header]) =>
    Math.max(header.length, ...rows.map((r) => r[key].length))
  );
  console.log(cols.map(([, h], c) => h.padEnd(widths[c])).join('  '));
  for (const r of rows) {
    console.log(cols.map(([key], c) => r[key].padEnd(widths[c])).join('  '));
  }
}

export function runPrune(opts: { keep: number; dryRun?: boolean }): void {
  const root = findProjectRoot(process.cwd());
  if (!root) {
    console.error('hiarky: no package.json found in this directory or any parent.');
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(opts.keep) || opts.keep < 1) {
    console.error('hiarky: --keep must be a positive integer.');
    process.exitCode = 1;
    return;
  }
  const entries = loadSnapshotEntries(root);
  const doomed = entries.slice(0, Math.max(0, entries.length - opts.keep));
  if (doomed.length === 0) {
    console.log(`Nothing to prune (${entries.length} snapshot(s), keeping ${opts.keep}).`);
    return;
  }
  for (const e of doomed) {
    if (opts.dryRun) console.log(`Would delete ${path.basename(e.file)}`);
    else fs.unlinkSync(e.file);
  }
  if (!opts.dryRun) {
    console.log(
      `Pruned ${doomed.length} snapshot(s); ${entries.length - doomed.length} kept.`
    );
  }
}
