import * as fs from 'fs';
import * as path from 'path';
import { diffSnapshots } from './diff';
import { loadSnapshotEntries } from './snap';

export interface ListRow {
  idx: string;
  when: string;
  commit: string;
  components: string;
  changes: string;
  id: string;
}

/** Table rows for every snapshot, oldest → newest. */
export function listRows(root: string): ListRow[] {
  const entries = loadSnapshotEntries(root);
  return entries.map((e, i) => {
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
}

export function listProject(root: string): void {
  const rows = listRows(root);
  if (rows.length === 0) {
    console.log('No snapshots yet. Run `hiarky snap` first.');
    return;
  }
  const cols: Array<[keyof ListRow, string]> = [
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

export interface PruneResult {
  deleted: string[];
  kept: number;
}

export function pruneProject(root: string, opts: { keep: number; dryRun?: boolean }): PruneResult {
  if (!Number.isInteger(opts.keep) || opts.keep < 1) {
    throw new Error('--keep must be a positive integer.');
  }
  const entries = loadSnapshotEntries(root);
  const doomed = entries.slice(0, Math.max(0, entries.length - opts.keep));
  if (doomed.length === 0) {
    console.log(`Nothing to prune (${entries.length} snapshot(s), keeping ${opts.keep}).`);
    return { deleted: [], kept: entries.length };
  }
  for (const e of doomed) {
    if (opts.dryRun) console.log(`Would delete ${path.basename(e.file)}`);
    else fs.unlinkSync(e.file);
  }
  if (!opts.dryRun) {
    console.log(`Pruned ${doomed.length} snapshot(s); ${entries.length - doomed.length} kept.`);
  }
  return { deleted: doomed.map((e) => e.file), kept: entries.length - doomed.length };
}
