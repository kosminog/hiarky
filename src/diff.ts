import { Snapshot } from './types';

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * Diff two snapshots by symbol id, flagging changes to the members, hooks,
 * signature, outgoing edges (order-insensitive), or body of each symbol.
 *
 * IMPORTANT: this function must stay fully self-contained (no references to
 * imports or other module members) — viewer.ts inlines its source verbatim
 * into the generated HTML so the CLI and the viewer can never disagree.
 */
export function diffSnapshots(prev: Snapshot, next: Snapshot): SnapshotDiff {
  const sig = (s: Snapshot['symbols'][number]) =>
    JSON.stringify([
      s.kind,
      s.export,
      s.signature ?? null,
      s.members ?? [],
      s.hooks ?? [],
      s.edges.map((e) => `${e.kind}:${e.name}`).sort(),
      s.bodyHash ?? '',
    ]);
  const a = new Map(prev.symbols.map((s) => [s.id, s]));
  const b = new Map(next.symbols.map((s) => [s.id, s]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [id, s] of b) {
    if (!a.has(id)) added.push(id);
    else if (sig(a.get(id)!) !== sig(s)) changed.push(id);
  }
  for (const id of a.keys()) if (!b.has(id)) removed.push(id);
  return { added, removed, changed };
}
