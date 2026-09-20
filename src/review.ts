import { EdgeKind, Snapshot, SymbolInfo, SymbolKind } from './types';

export type ChangeKind = 'added' | 'removed' | 'changed' | 'moved';

export type DeltaField =
  | 'export'
  | 'kind'
  | 'signature'
  | 'members'
  | 'role'
  | 'renders'
  | 'calls'
  | 'extends'
  | 'hooks'
  | 'body';

export interface FieldDelta {
  field: DeltaField;
  /** Entries present now but not before */
  added?: string[];
  /** Entries present before but not now */
  removed?: string[];
  /** Scalar fields record both sides instead */
  from?: string;
  to?: string;
}

export interface SymbolChange {
  kind: ChangeKind;
  /** Current id, or the previous id for a removal */
  id: string;
  name: string;
  file: string;
  symbolKind: SymbolKind;
  /** Whether the symbol is part of the module's public surface */
  exported: boolean;
  /** Set for moved/renamed symbols: where it used to live */
  previousId?: string;
  deltas: FieldDelta[];
  impact: number;
  /** Plain-language justification for the impact score */
  reasons: string[];
}

export interface Review {
  changes: SymbolChange[];
  /** Files that had no symbols before — their additions summarize as one line */
  newFiles: string[];
  stats: {
    added: number;
    removed: number;
    changed: number;
    moved: number;
    files: number;
  };
  /** Files whose exported surface changed — the API other code depends on */
  surfaceFiles: string[];
}

/**
 * How much each kind of change matters to a reviewer. Signature, member, and
 * export changes can break callers; a body edit usually cannot.
 */
const FIELD_WEIGHT: Record<DeltaField, number> = {
  export: 30,
  kind: 30,
  signature: 25,
  members: 20,
  role: 10,
  renders: 8,
  calls: 8,
  extends: 15,
  hooks: 8,
  body: 3,
};

/** Fields that change what other modules can rely on. */
const SURFACE_FIELDS: DeltaField[] = ['export', 'kind', 'signature', 'members', 'extends'];

function arrayDelta(field: DeltaField, before: string[], after: string[]): FieldDelta | null {
  const a = new Set(before);
  const b = new Set(after);
  const added = after.filter((x) => !a.has(x));
  const removed = before.filter((x) => !b.has(x));
  if (added.length === 0 && removed.length === 0) return null;
  return {
    field,
    ...(added.length ? { added } : {}),
    ...(removed.length ? { removed } : {}),
  };
}

function scalarDelta(field: DeltaField, before: string, after: string): FieldDelta | null {
  return before === after ? null : { field, from: before, to: after };
}

function edgeNames(s: SymbolInfo, kind: EdgeKind): string[] {
  return s.edges
    .filter((e) => e.kind === kind)
    .map((e) => e.name)
    .sort();
}

function hookNames(s: SymbolInfo): string[] {
  return (s.hooks ?? []).map((h) => (h.detail ? `${h.name} → ${h.detail}` : h.name));
}

/** Every field-level difference between two versions of the same symbol. */
export function symbolDeltas(before: SymbolInfo, after: SymbolInfo): FieldDelta[] {
  const deltas: FieldDelta[] = [];
  const add = (d: FieldDelta | null) => {
    if (d) deltas.push(d);
  };

  add(scalarDelta('export', before.export, after.export));
  add(scalarDelta('kind', before.kind, after.kind));
  add(scalarDelta('signature', before.signature ?? '', after.signature ?? ''));
  add(arrayDelta('members', before.members ?? [], after.members ?? []));
  add(arrayDelta('role', before.role ?? [], after.role ?? []));
  add(arrayDelta('renders', edgeNames(before, 'renders'), edgeNames(after, 'renders')));
  add(arrayDelta('calls', edgeNames(before, 'calls'), edgeNames(after, 'calls')));
  add(arrayDelta('extends', edgeNames(before, 'extends'), edgeNames(after, 'extends')));
  add(arrayDelta('hooks', hookNames(before), hookNames(after)));

  // A body hash always moves when anything else does, so it is only worth
  // reporting when nothing else explains the change.
  if (deltas.length === 0 && before.bodyHash !== after.bodyHash) {
    deltas.push({ field: 'body' });
  }
  return deltas;
}

function describe(field: DeltaField, symbolKind: SymbolKind): string {
  if (field === 'members') return symbolKind === 'component' ? 'props changed' : 'members changed';
  if (field === 'body') return 'body only';
  if (field === 'export') return 'export status changed';
  if (field === 'kind') return 'declaration kind changed';
  return `${field} changed`;
}

function scoreChange(change: Omit<SymbolChange, 'impact' | 'reasons'>): {
  impact: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  const exportedNote = change.exported ? 'exported' : 'internal';

  if (change.kind === 'moved') {
    reasons.push('moved or renamed, body identical');
    return { impact: 5, reasons };
  }
  if (change.kind === 'removed') {
    reasons.push(`${exportedNote} symbol removed`);
    return { impact: change.exported ? 40 : 10, reasons };
  }
  if (change.kind === 'added') {
    reasons.push(`${exportedNote} symbol added`);
    return { impact: change.exported ? 15 : 5, reasons };
  }

  let score = 0;
  for (const d of change.deltas) {
    score += FIELD_WEIGHT[d.field];
    reasons.push(describe(d.field, change.symbolKind));
  }
  // The same edit matters more when other modules can see it
  score = change.exported ? score * 1.5 : score * 0.5;
  if (change.exported) reasons.push('on the public surface');
  return { impact: Math.round(score), reasons };
}

/**
 * Pair removals with additions that carry the same body, so a file move or a
 * rename reads as one entry instead of a delete plus an unrelated addition.
 */
function detectMoves(
  removed: SymbolInfo[],
  added: SymbolInfo[]
): { moves: Array<[SymbolInfo, SymbolInfo]>; removed: SymbolInfo[]; added: SymbolInfo[] } {
  const moves: Array<[SymbolInfo, SymbolInfo]> = [];
  const takenAdds = new Set<SymbolInfo>();
  const takenRemoves = new Set<SymbolInfo>();

  const byHash = new Map<string, SymbolInfo[]>();
  for (const a of added) {
    if (!a.bodyHash) continue; // upgraded v1 snapshots carry no hashes
    const list = byHash.get(a.bodyHash) ?? [];
    list.push(a);
    byHash.set(a.bodyHash, list);
  }

  for (const r of removed) {
    if (!r.bodyHash) continue;
    const candidates = (byHash.get(r.bodyHash) ?? []).filter((c) => !takenAdds.has(c));
    if (candidates.length === 0) continue;
    // Prefer the candidate that kept the name, then the one in the same file;
    // an ambiguous hash (two identical one-liners) is left as add + remove.
    const best =
      candidates.find((c) => c.name === r.name) ??
      candidates.find((c) => c.file === r.file) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    if (!best) continue;
    takenAdds.add(best);
    takenRemoves.add(r);
    moves.push([r, best]);
  }

  return {
    moves,
    removed: removed.filter((r) => !takenRemoves.has(r)),
    added: added.filter((a) => !takenAdds.has(a)),
  };
}

export interface ReviewOptions {
  /**
   * Restrict the review to symbols in these files (project-relative). Used to
   * drop noise when only part of the tree was touched in a commit range.
   */
  files?: string[];
}

/** Compare two snapshots into a ranked, field-level review. */
export function reviewSnapshots(
  prev: Snapshot,
  next: Snapshot,
  opts: ReviewOptions = {}
): Review {
  const fileFilter = opts.files ? new Set(opts.files) : null;
  const keep = (s: SymbolInfo) => !fileFilter || fileFilter.has(s.file);

  const before = new Map(prev.symbols.filter(keep).map((s) => [s.id, s]));
  const after = new Map(next.symbols.filter(keep).map((s) => [s.id, s]));

  const addedSymbols: SymbolInfo[] = [];
  const removedSymbols: SymbolInfo[] = [];
  const changes: SymbolChange[] = [];

  for (const [id, s] of after) {
    const old = before.get(id);
    if (!old) {
      addedSymbols.push(s);
      continue;
    }
    const deltas = symbolDeltas(old, s);
    if (deltas.length === 0) continue;
    changes.push(
      finish({
        kind: 'changed',
        id,
        name: s.name,
        file: s.file,
        symbolKind: s.kind,
        exported: s.export !== 'none',
        deltas,
      })
    );
  }
  for (const [id, s] of before) {
    if (!after.has(id)) removedSymbols.push(s);
  }

  const moved = detectMoves(removedSymbols, addedSymbols);

  for (const [from, to] of moved.moves) {
    changes.push(
      finish({
        kind: 'moved',
        id: to.id,
        name: to.name,
        file: to.file,
        symbolKind: to.kind,
        exported: to.export !== 'none',
        previousId: from.id,
        deltas: symbolDeltas(from, to),
      })
    );
  }
  for (const s of moved.added) {
    changes.push(
      finish({
        kind: 'added',
        id: s.id,
        name: s.name,
        file: s.file,
        symbolKind: s.kind,
        exported: s.export !== 'none',
        deltas: [],
      })
    );
  }
  for (const s of moved.removed) {
    changes.push(
      finish({
        kind: 'removed',
        id: s.id,
        name: s.name,
        file: s.file,
        symbolKind: s.kind,
        exported: s.export !== 'none',
        deltas: [],
      })
    );
  }

  changes.sort((a, b) => b.impact - a.impact || a.id.localeCompare(b.id));

  const beforeFiles = new Set([...before.values()].map((s) => s.file));
  const newFiles = [
    ...new Set(
      changes
        .filter((c) => c.kind === 'added' && !beforeFiles.has(c.file))
        .map((c) => c.file)
    ),
  ].sort();

  const surfaceFiles = [
    ...new Set(
      changes
        .filter(
          (c) =>
            c.exported &&
            (c.kind === 'added' ||
              c.kind === 'removed' ||
              c.deltas.some((d) => SURFACE_FIELDS.includes(d.field)))
        )
        .map((c) => c.file)
    ),
  ].sort();

  return {
    changes,
    newFiles,
    stats: {
      added: changes.filter((c) => c.kind === 'added').length,
      removed: changes.filter((c) => c.kind === 'removed').length,
      changed: changes.filter((c) => c.kind === 'changed').length,
      moved: changes.filter((c) => c.kind === 'moved').length,
      files: new Set(changes.map((c) => c.file)).size,
    },
    surfaceFiles,
  };
}

function finish(change: Omit<SymbolChange, 'impact' | 'reasons'>): SymbolChange {
  return { ...change, ...scoreChange(change) };
}
