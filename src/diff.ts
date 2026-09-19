import { ComponentInfo, Snapshot } from './types';

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

function byId(s: Snapshot): Map<string, ComponentInfo> {
  return new Map(s.components.map((c) => [c.id, c]));
}

/** Same change signature the viewer uses: props, hooks, and rendered names. */
function sig(c: ComponentInfo): string {
  return JSON.stringify([c.props, c.hooks, c.renders.map((r) => r.name).sort()]);
}

export function diffSnapshots(prev: Snapshot, next: Snapshot): SnapshotDiff {
  const a = byId(prev);
  const b = byId(next);
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
