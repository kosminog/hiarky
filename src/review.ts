import { DECLARATIVE_KINDS, EdgeKind, Snapshot, SymbolInfo, SymbolKind } from './types';

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
  | 'route'
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
  /** URL served, for routes */
  route?: string;
  /** What the symbol exposes — populated for additions, where there is no delta to show */
  members?: string[];
  /** Role tags carried from the symbol, e.g. ["mutation", "protected"] */
  role?: string[];
  /**
   * Whether a test exercising this symbol changed in the same range:
   * "changed" — at least one covering suite changed
   * "unchanged" — suites cover it, none of them changed
   * "none" — no suite references it at all
   */
  tests?: 'changed' | 'unchanged' | 'none';
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
  /** Changes worth a test that had none change with them */
  untested: number;
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
  route: 35,
  members: 20,
  role: 10,
  renders: 8,
  calls: 8,
  extends: 15,
  hooks: 8,
  body: 3,
};

/**
 * Some kinds matter regardless of export status: a migration changes shared
 * database state, a route is reachable from outside the codebase entirely.
 */
const KIND_BOOST: Partial<Record<SymbolKind, number>> = {
  migration: 25,
  model: 15,
  route: 15,
  procedure: 10,
};

/**
 * Kinds that are public by nature. A model or a route is reachable from
 * outside its module no matter what its file exports.
 */
const PUBLIC_KINDS: SymbolKind[] = ['model', 'migration', 'route', 'procedure'];

/** Can code outside this module see the change? Drives both ranking and surface. */
function isPublicFacing(change: { exported: boolean; symbolKind: SymbolKind }): boolean {
  return change.exported || PUBLIC_KINDS.includes(change.symbolKind);
}

/**
 * A new environment variable breaks any deploy that does not set it, which
 * outranks the dependency bumps and script tweaks it sits beside.
 */
const ROLE_BOOST: Record<string, number> = { env: 15 };

const KIND_REASON: Partial<Record<SymbolKind, string>> = {
  migration: 'database migration',
  model: 'database model',
  route: 'HTTP route',
  procedure: 'API procedure',
};

/** Fields that change what other modules can rely on. */
const SURFACE_FIELDS: DeltaField[] = [
  'export',
  'kind',
  'signature',
  'members',
  'extends',
  'route',
];

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
  add(scalarDelta('route', before.route ?? '', after.route ?? ''));
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
  if (field === 'members') {
    if (symbolKind === 'component') return 'props changed';
    if (symbolKind === 'model') return 'fields changed';
    if (symbolKind === 'procedure') return 'input changed';
    return 'members changed';
  }
  if (field === 'body') {
    return DECLARATIVE_KINDS.includes(symbolKind) ? 'definition changed' : 'body only';
  }
  if (field === 'export') return 'export status changed';
  if (field === 'kind') return 'declaration kind changed';
  return `${field} changed`;
}

function scoreChange(change: Omit<SymbolChange, 'impact' | 'reasons'>): {
  impact: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  const publicFacing = isPublicFacing(change);
  const visibility = publicFacing ? 'exported' : 'internal';
  const roleBoost = (change.role ?? []).reduce((sum, r) => sum + (ROLE_BOOST[r] ?? 0), 0);

  if (change.kind === 'moved') {
    reasons.push('moved or renamed, body identical');
    return { impact: 5, reasons };
  }
  const boost = KIND_BOOST[change.symbolKind] ?? 0;
  const kindReason = KIND_REASON[change.symbolKind];
  if (kindReason && boost) reasons.push(kindReason);

  if (change.kind === 'removed') {
    reasons.push(`${visibility} symbol removed`);
    return { impact: (publicFacing ? 40 : 10) + boost + roleBoost, reasons };
  }
  if (change.kind === 'added') {
    reasons.push(`${visibility} symbol added`);
    return { impact: (publicFacing ? 15 : 5) + boost + roleBoost, reasons };
  }

  let score = boost;
  for (const d of change.deltas) {
    score += FIELD_WEIGHT[d.field];
    reasons.push(describe(d.field, change.symbolKind));
  }
  // The same edit matters more when other code can see it
  score = score * (publicFacing ? 1.5 : 0.5) + roleBoost;
  if (publicFacing) reasons.push('on the public surface');
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

/**
 * Which suites exercise which symbols, from both sides of the range so a
 * deleted suite still counts as coverage that existed.
 *
 * Coverage is recorded per symbol and per file: a test importing a router
 * exercises its procedures too, even though it never names them.
 */
const COVERAGE_DEPTH = 2;
const COVERAGE_EDGES: EdgeKind[] = ['calls', 'renders', 'references'];

function buildCoverage(snapshots: Snapshot[]): {
  bySymbol: Map<string, Set<string>>;
  byFile: Map<string, Set<string>>;
} {
  const bySymbol = new Map<string, Set<string>>();
  const byFile = new Map<string, Set<string>>();
  const byId = new Map<string, SymbolInfo>();
  for (const snapshot of snapshots) {
    for (const symbol of snapshot.symbols) if (!byId.has(symbol.id)) byId.set(symbol.id, symbol);
  }

  const add = (map: Map<string, Set<string>>, key: string, testId: string) => {
    const set = map.get(key) ?? new Set<string>();
    set.add(testId);
    map.set(key, set);
  };

  const targetsOf = (symbol: SymbolInfo) =>
    symbol.edges
      .filter((e) => e.id && COVERAGE_EDGES.includes(e.kind))
      .map((e) => e.id as string);

  for (const symbol of byId.values()) {
    if (symbol.kind !== 'test') continue;
    // A suite exercises what it calls, and what that in turn reaches: a test
    // on a root router does cover the procedures the router mounts. Bounded,
    // so a smoke test does not claim the whole codebase.
    const visited = new Set<string>();
    let frontier = targetsOf(symbol);
    for (let depth = 0; depth < COVERAGE_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (visited.has(id)) continue;
        visited.add(id);
        add(bySymbol, id, symbol.id);
        add(byFile, id.split('#')[0], symbol.id);
        const target = byId.get(id);
        if (target) next.push(...targetsOf(target));
      }
      frontier = next;
    }
  }
  return { bySymbol, byFile };
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
        ...(s.route ? { route: s.route } : {}),
        ...(s.role?.length ? { role: s.role } : {}),
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
        ...(to.route ? { route: to.route } : {}),
        ...(to.role?.length ? { role: to.role } : {}),
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
        ...(s.route ? { route: s.route } : {}),
        ...(s.role?.length ? { role: s.role } : {}),
        ...(s.members?.length ? { members: s.members } : {}),
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
        ...(s.route ? { route: s.route } : {}),
        ...(s.role?.length ? { role: s.role } : {}),
        exported: s.export !== 'none',
        deltas: [],
      })
    );
  }

  // Coverage comes from the whole snapshot, not the filtered slice: a suite
  // that did not change is still coverage, and its file is not in the diff.
  const coverage = buildCoverage([next, prev]);
  const changedTests = new Set(
    changes.filter((c) => c.symbolKind === 'test').map((c) => c.id)
  );
  for (const change of changes) {
    // Tests never import a schema model or package.json, so "no test
    // references this" would fire on every one of them and mean nothing.
    if (change.symbolKind === 'test' || DECLARATIVE_KINDS.includes(change.symbolKind)) continue;
    const covering = new Set([
      ...(coverage.bySymbol.get(change.id) ?? []),
      ...(coverage.byFile.get(change.file) ?? []),
    ]);
    change.tests =
      covering.size === 0
        ? 'none'
        : [...covering].some((id) => changedTests.has(id))
          ? 'changed'
          : 'unchanged';
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
            isPublicFacing(c) &&
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
    untested: changes.filter(
      (c) => c.tests !== undefined && c.tests !== 'changed' && c.impact >= 10
    ).length,
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
