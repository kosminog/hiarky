import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeFile } from '../src/analyze';
import { formatDelta } from '../src/report';
import { linkSymbols } from '../src/resolve';
import { reviewSnapshots } from '../src/review';
import { analyzeProject } from '../src/snap';
import { edgesOf, SymbolInfo } from '../src/types';
import { cleanup, makeProject, makeSnapshot, makeSymbol } from './helpers';

const GLOBALS = `/* tokens { not a rule } */
:root {
  --brand: #0a84ff;
  --radius: 4px;
}
.button, .link { color: var(--brand); background: url("data:image/png;base64,AAA;BBB"); }
.button:hover { color: red }
@media (min-width: 600px) {
  .button { padding : 8px   12px; }
}
@keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }
@font-face { font-family: "Inter"; font-weight: 700; src: url(inter.woff2); }
.button { border-radius: var(--radius); }
.wrapper { }
`;

/** GLOBALS again, formatted differently: same rules, same declarations. */
const GLOBALS_REFORMATTED = `:root{--brand:#0a84ff;--radius:4px}
.button,
.link {
  /* a note */
  color: var(--brand);
  background: url("data:image/png;base64,AAA;BBB");
}
.button:hover { color: red; }
.button {
  @media (min-width: 600px) { padding: 8px 12px }
}
@keyframes spin {
  from { transform: rotate(0); }
  to { transform: rotate(360deg); }
}
@font-face {
  font-family: Inter;
  font-weight: 700;
  src: url(inter.woff2);
}
.button { border-radius: var(--radius) }
`;

const CARD = `@use 'sass:math';
$spacing: 8px; // base unit
$accent: #f00 !default;
@mixin button-reset($size: 1rem) {
  border: 0;
  font-size: $size;
}
@function rem($px) { @return math.div($px, 16px) * 1rem; }
.card {
  padding: $spacing;
  @include button-reset(2rem);
  &:hover { color: $accent; }
  &-title, .subtitle { font: { family: Inter; size: rem(16px); } }
  @media (max-width: 600px) { padding: 0; }
  .body { margin: 0; }
}
`;

const NAV = `$nav-height: 48px
=reset
  margin: 0
.nav
  height: $nav-height
  +reset
  &.open
    display: block
  // a comment
  .item
    color: red
`;

const THEME = `@primary: #333;
@import "mixins";
.bordered(@width: 1px) { border: @width solid @primary; }
#header { .bordered(2px); color: @primary; }
`;

const BUTTON_MODULE = `.button { color: red; }
.button.primary, .icon { font-weight: bold; }
:global(.theme-dark) .button { color: white; }
`;

const BUTTON_TSX = `import styles from './Button.module.css';

export function Button() {
  return <button className={styles.button} />;
}
`;

let root: string;
const analyze = (rel: string) => analyzeFile(path.join(root, rel), rel);
const byName = (symbols: SymbolInfo[], name: string) => {
  const s = symbols.find((x) => x.name === name);
  if (!s) throw new Error(`no symbol ${name} in [${symbols.map((x) => x.name)}]`);
  return s;
};

beforeAll(() => {
  root = makeProject({
    'src/styles/globals.css': GLOBALS,
    'src/styles/globals.v2.css': GLOBALS_REFORMATTED,
    'src/styles/card.scss': CARD,
    'src/styles/nav.sass': NAV,
    'src/styles/theme.less': THEME,
    'src/Button.module.css': BUTTON_MODULE,
    'src/Button.tsx': BUTTON_TSX,
    'public/vendor.min.css': '.a{color:red}.b{color:blue}',
  });
});

afterAll(() => cleanup(root));

describe('css', () => {
  const symbols = () => analyze('src/styles/globals.css').symbols;

  it('records one symbol per rule, named by its selector', () => {
    expect(symbols().map((s) => s.name)).toEqual([
      ':root',
      '.button, .link',
      '.button:hover',
      '.button @media (min-width: 600px)',
      '@keyframes spin',
      '@font-face Inter 700',
      '.button',
    ]);
    expect(symbols().every((s) => s.kind === 'style' && s.lang === 'css')).toBe(true);
  });

  it('records declarations as members, keeping strings and urls intact', () => {
    expect(byName(symbols(), '.button, .link').members).toEqual([
      'color: var(--brand)',
      'background: url("data:image/png;base64,AAA;BBB")',
    ]);
    expect(byName(symbols(), ':root').members).toEqual(['--brand: #0a84ff', '--radius: 4px']);
    expect(byName(symbols(), '.button @media (min-width: 600px)').members).toEqual([
      'padding: 8px 12px',
    ]);
  });

  it('folds keyframe steps and font faces into their own symbols', () => {
    const spin = byName(symbols(), '@keyframes spin');
    expect(spin.role).toEqual(['keyframes']);
    expect(spin.members).toEqual(['from { transform: rotate(0) }', 'to { transform: rotate(360deg) }']);
    expect(byName(symbols(), '@font-face Inter 700').members).toEqual([
      'font-family: "Inter"',
      'font-weight: 700',
      'src: url(inter.woff2)',
    ]);
  });

  it('skips rules that only wrap nested rules, and treats global rules as public', () => {
    expect(symbols().map((s) => s.name)).not.toContain('.wrapper');
    expect(byName(symbols(), '.button').export).toBe('named');
  });

  it('records the line each rule starts on', () => {
    expect(byName(symbols(), ':root').line).toBe(2);
    expect(byName(symbols(), '@keyframes spin').line).toBe(11);
  });

  it('hashes normalized text, so formatting and comments do not count as changes', () => {
    const a = analyze('src/styles/globals.css').symbols;
    const b = analyze('src/styles/globals.v2.css').symbols;
    const strip = (s: SymbolInfo) => ({ name: s.name, members: s.members, hash: s.bodyHash });
    const names = new Set(b.map((s) => s.name));
    const same = a.filter((s) => s.name !== '@font-face Inter 700');
    expect(same.map(strip)).toEqual(b.filter((s) => s.name !== '@font-face Inter 700').map(strip));
    expect(names.has('.button @media (min-width: 600px)')).toBe(true);
  });
});

describe('scss', () => {
  const symbols = () => analyze('src/styles/card.scss').symbols;

  it('records variables with their values', () => {
    const spacing = byName(symbols(), '$spacing');
    expect(spacing).toMatchObject({
      kind: 'style',
      lang: 'scss',
      role: ['variable'],
      signature: '8px',
      export: 'named',
      line: 2,
    });
    expect(byName(symbols(), '$accent').signature).toBe('#f00 !default');
  });

  it('records mixins and functions with their parameters', () => {
    const mixin = byName(symbols(), '@mixin button-reset');
    expect(mixin.signature).toBe('($size: 1rem)');
    expect(mixin.role).toEqual(['mixin']);
    expect(mixin.members).toEqual(['border: 0', 'font-size: $size']);
    const fn = byName(symbols(), '@function rem');
    expect(fn.signature).toBe('($px)');
    expect(fn.members).toEqual(['@return math.div($px, 16px) * 1rem']);
  });

  it('flattens nested rules the way sass compiles them', () => {
    expect(symbols().map((s) => s.name)).toEqual([
      '$spacing',
      '$accent',
      '@mixin button-reset',
      '@function rem',
      '.card:hover',
      '.card-title, .card .subtitle',
      '.card @media (max-width: 600px)',
      '.card .body',
      '.card',
    ]);
    expect(byName(symbols(), '.card').members).toEqual([
      'padding: $spacing',
      '@include button-reset(2rem)',
    ]);
    expect(byName(symbols(), '.card:hover').members).toEqual(['color: $accent']);
    expect(byName(symbols(), '.card @media (max-width: 600px)').members).toEqual(['padding: 0']);
  });

  it('expands nested properties', () => {
    expect(byName(symbols(), '.card-title, .card .subtitle').members).toEqual([
      'font-family: Inter',
      'font-size: rem(16px)',
    ]);
  });

  it('ignores @use and @import statements', () => {
    expect(symbols().map((s) => s.name).join(' ')).not.toContain('@use');
  });
});

describe('indented sass', () => {
  const symbols = () => analyze('src/styles/nav.sass').symbols;

  it('reads the indented syntax like the braced one', () => {
    expect(symbols().map((s) => s.name)).toEqual([
      '$nav-height',
      '@mixin reset',
      '.nav.open',
      '.nav .item',
      '.nav',
    ]);
    expect(byName(symbols(), '.nav').members).toEqual(['height: $nav-height', '@include reset']);
    expect(byName(symbols(), '.nav.open').members).toEqual(['display: block']);
    expect(byName(symbols(), '.nav .item').line).toBe(10);
    expect(byName(symbols(), '.nav').lang).toBe('sass');
  });
});

describe('less', () => {
  const symbols = () => analyze('src/styles/theme.less').symbols;

  it('records variables, mixin definitions, and mixin calls', () => {
    expect(byName(symbols(), '@primary')).toMatchObject({
      role: ['variable'],
      signature: '#333',
      lang: 'less',
    });
    expect(byName(symbols(), '.bordered(@width: 1px)').members).toEqual([
      'border: @width solid @primary',
    ]);
    expect(byName(symbols(), '#header').members).toEqual(['.bordered(2px)', 'color: @primary']);
    expect(symbols().map((s) => s.name)).not.toContain('@import');
  });
});

describe('css modules', () => {
  it('exposes the classes a module declares as one default-exported symbol', () => {
    const symbols = analyze('src/Button.module.css').symbols;
    const mod = byName(symbols, 'Button');
    expect(mod).toMatchObject({ kind: 'style', export: 'default', role: ['module'] });
    expect(mod.members).toEqual(['.button', '.icon', '.primary']);
    // Rules in a module are scoped to it, so they are not public surface
    expect(byName(symbols, '.button').export).toBe('none');
  });

  it('links a component to the module it imports', () => {
    const { symbols } = linkSymbols(root, [analyze('src/Button.tsx'), analyze('src/Button.module.css')]);
    const button = symbols.find((s) => s.id === 'src/Button.tsx#Button')!;
    const ref = edgesOf(button, 'references').find((e) => e.name === 'styles');
    expect(ref?.id).toBe('src/Button.module.css#Button');
  });
});

describe('minified stylesheets', () => {
  it('records a minified bundle by hash alone', () => {
    const [sym, ...rest] = analyze('public/vendor.min.css').symbols;
    expect(rest).toEqual([]);
    expect(sym).toMatchObject({ name: 'vendor', kind: 'module', role: ['minified'] });
  });
});

describe('review', () => {
  const rule = (members: string[]) =>
    makeSymbol({
      id: 'src/styles/globals.css#.button',
      lang: 'css',
      kind: 'style',
      members,
      bodyHash: members.join(';'),
    });

  it('reports a changed declaration as a delta, with no test-coverage marker', () => {
    const { changes } = reviewSnapshots(
      makeSnapshot([rule(['color: red', 'padding: 4px'])]),
      makeSnapshot([rule(['color: blue', 'padding: 4px'])])
    );
    expect(changes).toHaveLength(1);
    const [change] = changes;
    expect(change.deltas).toEqual([
      { field: 'members', added: ['color: blue'], removed: ['color: red'] },
    ]);
    expect(change.tests).toBeUndefined();
    expect(change.reasons).toContain('declarations changed');
    expect(formatDelta(change.deltas[0], 'style')).toBe('declarations: +color: blue -color: red');
  });
});

describe('project scan', () => {
  it('scans every stylesheet dialect', async () => {
    const analysis = await analyzeProject(root);
    const langs = new Set(analysis.symbols.filter((s) => s.kind === 'style').map((s) => s.lang));
    expect([...langs].sort()).toEqual(['css', 'less', 'sass', 'scss']);
  });
});
