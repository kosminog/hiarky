import { Snapshot } from './types';

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * Diff two snapshots by component id, flagging changes to props, hooks, or
 * rendered children (order-insensitive).
 *
 * IMPORTANT: this function must stay fully self-contained (no references to
 * imports or other module members) — viewer.ts inlines its source verbatim
 * into the generated HTML so the CLI and the viewer can never disagree.
 */
export function diffSnapshots(prev: Snapshot, next: Snapshot): SnapshotDiff {
  const sig = (c: Snapshot['components'][number]) =>
    JSON.stringify([c.props, c.hooks, c.renders.map((r) => r.name).sort()]);
  const a = new Map(prev.components.map((c) => [c.id, c]));
  const b = new Map(next.components.map((c) => [c.id, c]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [id, c] of b) {
    if (!a.has(id)) added.push(id);
    else if (sig(a.get(id)!) !== sig(c)) changed.push(id);
  }
  for (const id of a.keys()) if (!b.has(id)) removed.push(id);
  return { added, removed, changed };
}
