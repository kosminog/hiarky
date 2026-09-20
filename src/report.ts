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

export function renderMarkdown(review: Review, ctx: ReportContext): string {
  const out: string[] = [];
  out.push(`## ${ctx.title ?? 'hiarky review'}`, '');
  out.push(scope(ctx), '');
  out.push(`**${headline(review, ctx)}**`);

  if (review.changes.length === 0) {
    out.push('', 'No symbol-level changes in this range.');
    return out.join('\n') + '\n';
  }

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

  return out.join('\n') + '\n';
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

/** Upper bound of a tier: the next threshold above `min`. */
function tierAbove(min: number): number {
  return min >= HIGH ? Number.POSITIVE_INFINITY : min >= MEDIUM ? HIGH : MEDIUM;
}
