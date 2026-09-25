import { FieldDelta, Review, SymbolChange } from './review';
import { DECLARATIVE_KINDS, SymbolKind } from './types';

export interface ReportContext {
  /** Label for the earlier side, e.g. a short sha or a timestamp */
  from: string;
  to: string;
  /** Number of commits in the range, when reviewing a git range */
  commits?: number;
  /** Files touched in the range, when known from git */
  files?: number;
  title?: string;
}

const HIGH = 25;
const MEDIUM = 10;
/** Longest delta list worth printing in full before it becomes noise */
const MAX_ENTRIES = 6;
const MAX_SIGNATURE = 90;

const TIERS: Array<{ label: string; min: number }> = [
  { label: 'High impact', min: HIGH },
  { label: 'Worth a look', min: MEDIUM },
  { label: 'Minor', min: 0 },
];

function fieldLabel(field: FieldDelta['field'], symbolKind: SymbolKind): string {
  if (field === 'members') {
    if (symbolKind === 'component') return 'props';
    if (symbolKind === 'model') return 'fields';
    if (symbolKind === 'procedure') return 'input';
    if (symbolKind === 'migration') return 'statements';
    if (symbolKind === 'test') return 'cases';
    return 'members';
  }
  return field;
}

function ellipsize(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/** One delta as a single line: `props: +subtitle -theme` or `signature: a → b`. */
export function formatDelta(delta: FieldDelta, symbolKind: SymbolKind): string {
  const label = fieldLabel(delta.field, symbolKind);
  if (delta.field === 'body') {
    return DECLARATIVE_KINDS.includes(symbolKind) ? 'definition changed' : 'body only';
  }
  if (delta.from !== undefined || delta.to !== undefined) {
    const from = ellipsize(delta.from || '(none)', MAX_SIGNATURE);
    const to = ellipsize(delta.to || '(none)', MAX_SIGNATURE);
    return `${label}: ${from} → ${to}`;
  }
  const parts = [
    ...(delta.added ?? []).map((x) => `+${x}`),
    ...(delta.removed ?? []).map((x) => `-${x}`),
  ];
  // A wholesale rewrite can touch dozens of call sites; the full list lives in
  // --format json, the summary keeps the report readable.
  if (parts.length > MAX_ENTRIES) {
    const shown = parts.slice(0, MAX_ENTRIES).join(' ');
    return `${label}: ${shown} … (${parts.length - MAX_ENTRIES} more)`;
  }
  return `${label}: ${parts.join(' ')}`;
}

/** For an addition there is no delta to print, so show what it exposes. */
function addedMembersLine(change: SymbolChange): string | null {
  if (change.kind !== 'added' || !change.members?.length) return null;
  const label = fieldLabel('members', change.symbolKind);
  const shown = change.members.slice(0, MAX_ENTRIES).join(', ');
  const rest = change.members.length - MAX_ENTRIES;
  return `${label}: ${shown}${rest > 0 ? ` … (${rest} more)` : ''}`;
}

/**
 * Test case names contain commas and read as sentences, so they get one line
 * each rather than being joined into an ambiguous list.
 */
function caseLines(change: SymbolChange): string[] {
  const entries: string[] = [];
  if (change.kind === 'added') {
    entries.push(...(change.members ?? []).map((c) => `+ ${c}`));
  }
  for (const delta of change.deltas) {
    if (delta.field !== 'members') continue;
    entries.push(...(delta.added ?? []).map((c) => `+ ${c}`));
    entries.push(...(delta.removed ?? []).map((c) => `- ${c}`));
  }
  if (entries.length <= MAX_ENTRIES) return entries;
  return [...entries.slice(0, MAX_ENTRIES), `… (${entries.length - MAX_ENTRIES} more)`];
}

/** Flag a change that mattered enough to expect a test to move with it. */
function testNote(change: SymbolChange): string | null {
  if (!change.tests || change.impact < MEDIUM) return null;
  if (change.tests === 'changed') return null;
  return change.tests === 'none' ? 'no tests reference this' : 'no test change';
}

function verb(change: SymbolChange): string {
  return change.kind === 'moved' ? 'moved' : change.kind;
}

function tags(change: SymbolChange): string {
  const parts: string[] = [change.symbolKind];
  if (change.route) parts.push(change.route);
  if (change.symbolKind === 'procedure' && change.role?.length) parts.push(...change.role);
  // "exported" means nothing for a schema model or an env file
  if (!DECLARATIVE_KINDS.includes(change.symbolKind)) {
    parts.push(change.exported ? 'exported' : 'internal');
  }
  return parts.join(' · ');
}

/** Body-only edits are real but rarely the point; they collapse into one line. */
function splitBodyOnly(changes: SymbolChange[]): {
  notable: SymbolChange[];
  bodyOnly: SymbolChange[];
} {
  const bodyOnly = changes.filter(
    (c) =>
      c.kind === 'changed' &&
      c.deltas.length === 1 &&
      c.deltas[0].field === 'body' &&
      // A model or migration definition changing is the finding, not noise
      !DECLARATIVE_KINDS.includes(c.symbolKind)
  );
  const set = new Set(bodyOnly);
  return {
    notable: changes.filter((c) => !set.has(c)),
    bodyOnly: [...bodyOnly].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Test suites are their own story; they would otherwise flood the tiers. */
function splitTests(changes: SymbolChange[]): {
  rest: SymbolChange[];
  tests: SymbolChange[];
} {
  const tests = changes.filter((c) => c.symbolKind === 'test');
  const set = new Set(tests);
  return { rest: changes.filter((c) => !set.has(c)), tests };
}

/**
 * Symbols added by a brand-new file are not N separate findings — the file is
 * the finding. They summarize as one line per file instead.
 */
function splitNewFiles(
  changes: SymbolChange[],
  newFiles: string[]
): { rest: SymbolChange[]; perFile: Array<{ file: string; exported: number; total: number }> } {
  const isNew = new Set(newFiles);
  // High-impact additions — a migration, a model, a route — are the finding
  // even when their file is new, so they stay listed individually.
  const folded = changes.filter(
    (c) => c.kind === 'added' && isNew.has(c.file) && c.impact < HIGH
  );
  const set = new Set(folded);
  const perFile = newFiles
    .map((file) => {
      const syms = folded.filter((c) => c.file === file);
      return { file, exported: syms.filter((c) => c.exported).length, total: syms.length };
    })
    .filter((entry) => entry.total > 0);
  return { rest: changes.filter((c) => !set.has(c)), perFile };
}

function newFileLine(entry: { file: string; exported: number; total: number }): string {
  return `${entry.file} — ${entry.total} symbol${entry.total === 1 ? '' : 's'}, ${entry.exported} exported`;
}

function headline(review: Review, ctx: ReportContext): string {
  const s = review.stats;
  const bits: string[] = [];
  if (s.added) bits.push(`${s.added} added`);
  if (s.removed) bits.push(`${s.removed} removed`);
  if (s.changed) bits.push(`${s.changed} changed`);
  if (s.moved) bits.push(`${s.moved} moved`);
  if (bits.length === 0) return 'no symbol changes';
  if (review.untested > 0) {
    bits.push(`${review.untested} without a test change`);
  }
  return bits.join(' · ');
}

function scope(ctx: ReportContext): string {
  const bits = [`${ctx.from} → ${ctx.to}`];
  if (ctx.commits !== undefined) {
    bits.push(`${ctx.commits} commit${ctx.commits === 1 ? '' : 's'}`);
  }
  if (ctx.files !== undefined) bits.push(`${ctx.files} file${ctx.files === 1 ? '' : 's'} touched`);
  return bits.join(' · ');
}

function markdownHeader(review: Review, ctx: ReportContext): string[] {
  return [`## ${ctx.title ?? 'hiarky review'}`, '', scope(ctx), '', `**${headline(review, ctx)}**`];
}

export function renderMarkdown(review: Review, ctx: ReportContext): string {
  const out = markdownHeader(review, ctx);
  if (review.changes.length === 0) {
    out.push('', 'No symbol-level changes in this range.');
    return out.join('\n') + '\n';
  }
  out.push(...markdownBody(review));
  return out.join('\n') + '\n';
}

/** Everything below the headline: surface files, new files, tiers, tests, body-only. */
function markdownBody(review: Review): string[] {
  const out: string[] = [];
  if (review.surfaceFiles.length) {
    out.push(
      '',
      `${review.surfaceFiles.length} file${review.surfaceFiles.length === 1 ? '' : 's'} changed their public surface:`,
      ...review.surfaceFiles.map((f) => `- \`${f}\``)
    );
  }

  const { rest: notTests, tests } = splitTests(review.changes);
  const { rest, perFile } = splitNewFiles(notTests, review.newFiles);
  const { notable, bodyOnly } = splitBodyOnly(rest);

  if (perFile.length) {
    out.push('', `### New files (${perFile.length})`, '');
    for (const entry of perFile) out.push(`- \`${entry.file}\` — ${entry.total} symbol${entry.total === 1 ? '' : 's'}, ${entry.exported} exported`);
  }

  for (const tier of TIERS) {
    const inTier = notable.filter(
      (c) => c.impact >= tier.min && (tier.min === HIGH || c.impact < tierAbove(tier.min))
    );
    if (inTier.length === 0) continue;
    out.push('', `### ${tier.label}`, '');
    for (const c of inTier) {
      const where =
        c.previousId && c.previousId !== c.id
          ? `\`${c.previousId}\` → \`${c.id}\``
          : `\`${c.file}\``;
      const note = testNote(c);
      out.push(
        `- **${c.name}** ${verb(c)} · ${tags(c)}${note ? ` · _${note}_` : ''} — ${where}`
      );
      const added = addedMembersLine(c);
      if (added) out.push(`  - ${added}`);
      for (const d of c.deltas) {
        if (d.field === 'body' && c.kind !== 'changed') continue;
        out.push(`  - ${formatDelta(d, c.symbolKind)}`);
      }
    }
  }

  if (tests.length) {
    out.push('', `### Tests (${tests.length})`, '');
    for (const c of tests) {
      out.push(`- **${c.name}** ${verb(c)} — \`${c.file}\``);
      for (const line of caseLines(c)) out.push(`  - ${line}`);
      for (const d of c.deltas) {
        if (d.field === 'members') continue; // already listed case by case
        out.push(`  - ${formatDelta(d, c.symbolKind)}`);
      }
    }
  }

  if (bodyOnly.length) {
    out.push(
      '',
      `<details><summary>${bodyOnly.length} body-only change${bodyOnly.length === 1 ? '' : 's'}</summary>`,
      '',
      ...bodyOnly.map((c) => `- \`${c.id}\``),
      '',
      '</details>'
    );
  }
  return out;
}

export function renderText(review: Review, ctx: ReportContext): string {
  const out: string[] = [];
  // In --per-commit mode the title carries the commit subject; without it the
  // sections are indistinguishable walls of shas.
  if (ctx.title) out.push(ctx.title);
  out.push(scope(ctx));
  out.push(headline(review, ctx));

  if (review.changes.length === 0) {
    out.push('', 'No symbol-level changes in this range.');
    return out.join('\n') + '\n';
  }

  if (review.surfaceFiles.length) {
    out.push(`public surface touched in ${review.surfaceFiles.length} file(s)`);
  }

  const { rest: notTests, tests } = splitTests(review.changes);
  const { rest, perFile } = splitNewFiles(notTests, review.newFiles);
  const { notable, bodyOnly } = splitBodyOnly(rest);

  if (perFile.length) {
    out.push('', `NEW FILES (${perFile.length})`);
    for (const entry of perFile) out.push(`  ${newFileLine(entry)}`);
  }

  for (const tier of TIERS) {
    const inTier = notable.filter(
      (c) => c.impact >= tier.min && (tier.min === HIGH || c.impact < tierAbove(tier.min))
    );
    if (inTier.length === 0) continue;
    out.push('', `${tier.label.toUpperCase()}`);
    for (const c of inTier) {
      const where =
        c.previousId && c.previousId !== c.id ? `${c.previousId} -> ${c.id}` : c.id;
      const note = testNote(c);
      out.push(`  ${verb(c).padEnd(8)} ${where}  [${tags(c)}]${note ? `  (${note})` : ''}`);
      const added = addedMembersLine(c);
      if (added) out.push(`             ${added}`);
      for (const d of c.deltas) {
        if (d.field === 'body' && c.kind !== 'changed') continue;
        out.push(`             ${formatDelta(d, c.symbolKind)}`);
      }
    }
  }

  if (tests.length) {
    out.push('', `TESTS (${tests.length})`);
    for (const c of tests) {
      out.push(`  ${verb(c).padEnd(8)} ${c.name}  [${c.file}]`);
      for (const line of caseLines(c)) out.push(`             ${line}`);
      for (const d of c.deltas) {
        if (d.field === 'members') continue; // already listed case by case
        out.push(`             ${formatDelta(d, c.symbolKind)}`);
      }
    }
  }

  if (bodyOnly.length) {
    out.push('', `BODY ONLY (${bodyOnly.length})`);
    for (const c of bodyOnly) out.push(`  ${c.id}`);
  }

  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// GitHub-flavored report: the markdown report with a visual summary on top.
// Everything here renders in a pull request comment or a job summary without
// hosting anything: Unicode bars in tables and a Mermaid diagram, which GitHub
// draws natively. Plain `md` stays free of these so other renderers are safe.

/** GitHub rejects comment bodies over 65536 characters; leave room for a marker. */
const MAX_COMMENT = 60000;
const MAX_GRAPH_NODES = 15;
const MAX_GRAPH_DEPENDENTS = 12;
const MAX_TABLE_ROWS = 12;
/** Impact at which a bar reads as full; a public signature-and-members change scores 67. */
const BAR_SCALE = 60;
const BAR_WIDTH = 12;

const KIND_ORDER: SymbolKind[] = [
  'migration',
  'model',
  'route',
  'procedure',
  'config',
  'component',
  'class',
  'method',
  'function',
  'type',
  'const',
  'module',
  'test',
];

function bar(value: number, total: number, width = BAR_WIDTH): string {
  const filled = total > 0 ? Math.min(width, Math.round((value / total) * width)) : 0;
  return '`' + '█'.repeat(filled) + '░'.repeat(width - filled) + '`';
}

/** A table cell: pipes would end the cell, and a code span keeps signatures literal. */
function cell(text: string): string {
  return '`' + text.replace(/`/g, "'").replace(/\|/g, '\\|') + '`';
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function isPublic(change: SymbolChange): boolean {
  return change.exported || ['model', 'migration', 'route', 'procedure'].includes(change.symbolKind);
}

function tilesSection(review: Review, counted: SymbolChange[]): string[] {
  const high = counted.filter((c) => c.impact >= HIGH).length;
  const medium = counted.filter((c) => c.impact >= MEDIUM && c.impact < HIGH).length;
  const minor = counted.length - high - medium;
  const out = ['| | | |', '|---|---|---|'];
  out.push(
    `| **Impact** | ${bar(high, counted.length)} | ${high} high · ${medium} worth a look · ${minor} minor |`
  );
  out.push(
    `| **Public surface** | ${bar(review.surfaceFiles.length, review.stats.files)} | ` +
      `${review.surfaceFiles.length} of ${plural(review.stats.files, 'file')} changed what they export |`
  );
  const tested = review.changes.filter((c) => c.tests !== undefined);
  if (tested.length) {
    const covered = tested.filter((c) => c.tests === 'changed').length;
    const stale = tested.filter((c) => c.tests === 'unchanged').length;
    const none = tested.length - covered - stale;
    out.push(
      `| **Tests moved with it** | ${bar(covered, tested.length)} | ` +
        `${covered} covered by a changed suite · ${stale} no test change · ${none} no tests reference this |`
    );
  }
  return out;
}

function kindSection(review: Review): string[] {
  const rows = new Map<SymbolKind, Record<string, number>>();
  for (const c of review.changes) {
    const row = rows.get(c.symbolKind) ?? { added: 0, removed: 0, changed: 0, moved: 0, max: 0 };
    row[c.kind] += 1;
    row.max = Math.max(row.max, c.impact);
    rows.set(c.symbolKind, row);
  }
  const out = [
    '### What changed, by kind',
    '',
    '| kind | added | removed | changed | moved | highest impact |',
    '|---|--:|--:|--:|--:|---|',
  ];
  const order = (k: SymbolKind) => {
    const i = KIND_ORDER.indexOf(k);
    return i === -1 ? KIND_ORDER.length : i;
  };
  for (const kind of [...rows.keys()].sort((a, b) => order(a) - order(b))) {
    const r = rows.get(kind)!;
    const n = (v: number) => (v ? String(v) : '');
    out.push(
      `| ${kind} | ${n(r.added)} | ${n(r.removed)} | ${n(r.changed)} | ${n(r.moved)} | ` +
        `${bar(r.max, BAR_SCALE, 8)} ${r.max} |`
    );
  }
  return out;
}

/** Mermaid reads `"` as the end of a label and HTML tags as markup. */
function mermaidLabel(text: string): string {
  return text
    .replace(/&/g, '#amp;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;');
}

function graphNote(change: SymbolChange): string {
  if (change.kind !== 'changed') return change.kind;
  const fields = change.deltas.map((d) => fieldLabel(d.field, change.symbolKind));
  return fields.filter((f) => f !== 'body').join(', ') || 'body';
}

/**
 * The blast radius: the most important changes, grouped by file, with the
 * edges between them and the unchanged files that depend on them. Dependents
 * collapse to one node per file — a widely used type can have dozens of
 * callers, and listing them all is what makes graphs unreadable.
 */
function graphSection(review: Review, notable: SymbolChange[]): string[] {
  const shown = notable.filter((c) => c.impact >= MEDIUM).slice(0, MAX_GRAPH_NODES);
  if (shown.length === 0) return [];
  const shownIds = new Set(shown.map((c) => c.id));
  const edges = review.graph.edges.filter((e) => shownIds.has(e.from) && shownIds.has(e.to));
  const dependents = review.graph.dependents
    .map((d) => ({ ...d, targets: d.targets.filter((t) => shownIds.has(t)) }))
    .filter((d) => d.targets.length > 0)
    .sort((a, b) => b.symbols - a.symbols || a.file.localeCompare(b.file));
  if (edges.length === 0 && dependents.length === 0) return [];

  const ids = new Map<string, string>();
  const nodeId = (key: string) => {
    let id = ids.get(key);
    if (!id) {
      id = `n${ids.size + 1}`;
      ids.set(key, id);
    }
    return id;
  };

  const lines = ['flowchart LR'];
  const byFile = new Map<string, SymbolChange[]>();
  for (const c of shown) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  for (const [file, changes] of byFile) {
    lines.push(`  subgraph ${nodeId(`file:${file}`)}["${mermaidLabel(file)}"]`);
    for (const c of changes) {
      const warn = c.tests && c.tests !== 'changed' ? ' ⚠' : '';
      const cls =
        c.kind === 'added' ? 'added' : c.kind === 'removed' ? 'removed' : c.impact >= HIGH ? 'high' : 'changed';
      lines.push(
        `    ${nodeId(c.id)}["${mermaidLabel(c.name)}${warn}<br/><i>${mermaidLabel(graphNote(c))}</i>"]:::${cls}`
      );
    }
    lines.push('  end');
  }
  const visible = dependents.slice(0, MAX_GRAPH_DEPENDENTS);
  for (const d of visible) {
    const id = nodeId(`dep:${d.file}`);
    lines.push(
      `  ${id}(["${mermaidLabel(d.file)}<br/>${plural(d.symbols, 'dependent')}"]):::${d.test ? 'test' : 'dep'}`
    );
    for (const target of d.targets) lines.push(`  ${id} -.-> ${nodeId(target)}`);
  }
  if (dependents.length > visible.length) {
    const rest = dependents.slice(visible.length);
    const files = rest.length;
    const symbols = rest.reduce((sum, d) => sum + d.symbols, 0);
    lines.push(
      `  ${nodeId('dep:rest')}(["${plural(files, 'more file')}<br/>${plural(symbols, 'dependent')}"]):::dep`
    );
  }
  for (const e of edges) lines.push(`  ${nodeId(e.from)} --> ${nodeId(e.to)}`);
  lines.push(
    '  classDef high fill:#fde68a,stroke:#b45309,color:#78350f',
    '  classDef changed fill:#fef3c7,stroke:#d97706,color:#78350f',
    '  classDef added fill:#dcfce7,stroke:#16a34a,color:#14532d',
    '  classDef removed fill:#fee2e2,stroke:#dc2626,color:#7f1d1d',
    '  classDef dep fill:#f3f4f6,stroke:#9ca3af,color:#374151',
    '  classDef test fill:#f0fdf4,stroke:#86efac,color:#166534,stroke-dasharray:4 3'
  );

  const changedCount = notable.filter((c) => c.impact >= MEDIUM).length;
  const intro =
    `Changes ranked highest (amber: changed, green: added, red: removed; ⚠ no test moved with it) ` +
    `and, dotted, the unchanged files that depend on them.` +
    (changedCount > shown.length ? ` ${shown.length} of ${changedCount} shown.` : '');
  return ['### Blast radius', '', intro, '', '```mermaid', ...lines, '```'];
}

/** The API diff: what exported symbols looked like before and after. */
function surfaceSection(review: Review): string[] {
  const rows: string[] = [];
  const surface = review.changes.filter(
    (c) =>
      isPublic(c) &&
      c.symbolKind !== 'test' &&
      (c.kind === 'removed' ||
        c.deltas.some((d) => ['signature', 'members', 'export', 'route'].includes(d.field)))
  );
  for (const c of surface) {
    const name = `\`${c.name}\``;
    if (c.kind === 'removed') {
      rows.push(`| ${name} | ${c.symbolKind} | _removed_ |`);
      continue;
    }
    for (const d of c.deltas) {
      const label = fieldLabel(d.field, c.symbolKind);
      if (d.from !== undefined || d.to !== undefined) {
        rows.push(`| ${name} · ${label} | ${cell(d.from || '(none)')} | ${cell(d.to || '(none)')} |`);
      } else if (d.field === 'members') {
        const parts = [
          ...(d.added ?? []).map((x) => cell('+' + x)),
          ...(d.removed ?? []).map((x) => cell('-' + x)),
        ];
        rows.push(`| ${name} · ${label} | | ${parts.join(' ')} |`);
      }
    }
  }
  if (rows.length === 0) return [];
  const out = ['### Public surface', '', '| symbol | was | now |', '|---|---|---|'];
  out.push(...rows.slice(0, MAX_TABLE_ROWS));
  if (rows.length > MAX_TABLE_ROWS) {
    out.push(`| _… ${rows.length - MAX_TABLE_ROWS} more_ | | |`);
  }
  return out;
}

/** Files ranked by their most important change — a reading order for the diff. */
function filesSection(review: Review): string[] {
  const files = new Map<
    string,
    { added: number; removed: number; changed: number; max: number; untested: number }
  >();
  for (const c of review.changes) {
    const f = files.get(c.file) ?? { added: 0, removed: 0, changed: 0, max: 0, untested: 0 };
    if (c.kind === 'added') f.added += 1;
    else if (c.kind === 'removed') f.removed += 1;
    else f.changed += 1;
    f.max = Math.max(f.max, c.impact);
    if (c.tests && c.tests !== 'changed' && c.impact >= MEDIUM) f.untested += 1;
    files.set(c.file, f);
  }
  const ranked = [...files].sort((a, b) => b[1].max - a[1].max || a[0].localeCompare(b[0]));
  const out = ['### Files', '', '| file | + − ~ | impact | |', '|---|---|---|---|'];
  for (const [file, f] of ranked.slice(0, MAX_TABLE_ROWS)) {
    const flags = [
      review.surfaceFiles.includes(file) ? 'surface' : '',
      review.newFiles.includes(file) ? 'new' : '',
      f.untested ? `${f.untested} untested` : '',
    ].filter(Boolean);
    out.push(
      `| \`${file}\` | +${f.added} −${f.removed} ~${f.changed} | ${bar(f.max, BAR_SCALE, 8)} ${f.max} | ${flags.join(' · ')} |`
    );
  }
  if (ranked.length > MAX_TABLE_ROWS) {
    out.push(`| _… ${ranked.length - MAX_TABLE_ROWS} more_ | | | |`);
  }
  return out;
}

/**
 * Markdown for a GitHub comment or job summary: a visual summary, then the
 * full report folded away. Sections drop from the bottom up when the whole
 * would not fit in a comment.
 */
export function renderGithub(review: Review, ctx: ReportContext): string {
  const out = markdownHeader(review, ctx);
  if (review.changes.length === 0) {
    out.push('', 'No symbol-level changes in this range.');
    return out.join('\n') + '\n';
  }

  const { rest: notTests } = splitTests(review.changes);
  const { rest } = splitNewFiles(notTests, review.newFiles);
  const { notable } = splitBodyOnly(rest);

  const required = [...out, '', ...tilesSection(review, notTests), '', ...kindSection(review)];
  const optional: string[][] = [
    graphSection(review, notable),
    surfaceSection(review),
    filesSection(review),
    ['<details><summary>Full report</summary>', ...markdownBody(review), '', '</details>'],
  ].filter((section) => section.length > 0);

  const assemble = (sections: string[][]) =>
    [...required, ...sections.flatMap((section) => ['', ...section])].join('\n') + '\n';
  // Drop the least visual section first: the folded report is a click away
  // in `--format md`, the file table is next, and the graph goes last.
  for (let keep = optional.length; keep >= 0; keep--) {
    const text = assemble(optional.slice(0, keep));
    if (text.length <= MAX_COMMENT) return text;
  }
  return assemble([]);
}

// ---------------------------------------------------------------------------
// GitHub Actions annotations: the same findings, placed on the diff itself.

/** The runner shows at most this many warnings, and this many notices, per step. */
const MAX_ANNOTATIONS = 10;

/** Workflow-command escaping for the message part. */
function commandData(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Property values additionally cannot carry the separators. */
function commandProperty(text: string): string {
  return commandData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/**
 * One workflow command per change worth a look, on the symbol's line, so the
 * finding sits next to the code in the pull request's diff. A change no test
 * moved with is a warning; the rest are notices. Each level is capped at what
 * the runner will show, most important first; the comment has the rest.
 */
export function renderActions(review: Review): string {
  const { rest: notTests } = splitTests(review.changes);
  const { rest } = splitNewFiles(notTests, review.newFiles);
  const { notable } = splitBodyOnly(rest);
  const shown = { warning: 0, notice: 0 };
  const out: string[] = [];
  for (const c of notable) {
    if (c.impact < MEDIUM) continue;
    const note = testNote(c);
    const level = note ? 'warning' : 'notice';
    if (shown[level] >= MAX_ANNOTATIONS) continue;
    shown[level] += 1;

    const props = [`file=${commandProperty(c.file)}`];
    // A removed symbol has no line in the new tree; the file is the anchor
    if (c.line) props.push(`line=${c.line}`);
    props.push(`title=${commandProperty(`hiarky: ${c.name} ${verb(c)} · ${tags(c)}`)}`);

    const lines: string[] = [];
    const added = addedMembersLine(c);
    if (added) lines.push(added);
    for (const d of c.deltas) lines.push(formatDelta(d, c.symbolKind));
    if (note) lines.push(note);
    lines.push(`impact ${c.impact}: ${c.reasons.join(', ')}`);
    out.push(`::${level} ${props.join(',')}::${commandData(lines.join('\n'))}`);
  }
  return out.length ? out.join('\n') + '\n' : '';
}

/** Upper bound of a tier: the next threshold above `min`. */
function tierAbove(min: number): number {
  return min >= HIGH ? Number.POSITIVE_INFINITY : min >= MEDIUM ? HIGH : MEDIUM;
}
