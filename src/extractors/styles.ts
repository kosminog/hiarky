import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { FileAnalysis, Lang, SymbolInfo } from '../types';

/**
 * Stylesheets: CSS, SCSS, the indented Sass syntax, and Less.
 *
 * Every top-level rule becomes a symbol named by its selector, with its
 * declarations as members, so a color change reads as `-color: red` /
 * `+color: blue` the way a dependency bump does. Nested rules flatten the way
 * Sass compiles them (`.a { &:hover {} }` is `.a:hover`), and a rule inside a
 * `@media` block carries the query in its name, so the same rule written
 * either way around gets the same id. Variables, mixins, functions,
 * keyframes, and font faces are symbols of their own.
 *
 * Hashes are taken over whitespace-normalized text, so a formatter run does
 * not show as a change to every rule in the project.
 *
 * A CSS module (`*.module.css` and friends) also gets one default-exported
 * symbol listing the classes it exposes, which is what `import styles from
 * './Button.module.css'` resolves to: the component then carries a
 * `references` edge to its stylesheet.
 */

const LANG_BY_EXT = new Map<string, Lang>([
  ['.css', 'css'],
  ['.scss', 'scss'],
  ['.sass', 'sass'],
  ['.less', 'less'],
]);

export const STYLE_GLOBS = ['**/*.{css,scss,sass,less}'];

const MODULE_FILE = /\.module\.(css|scss|sass|less)$/;

export function matchesStyles(file: string): boolean {
  return LANG_BY_EXT.has(path.extname(file));
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

interface Decl {
  kind: 'decl';
  text: string;
  line: number;
}

interface Block {
  kind: 'block';
  header: string;
  children: Node[];
  line: number;
}

type Node = Decl | Block;

/**
 * At-rules that group what they contain rather than declare something of
 * their own. A rule inside one keeps its selector and gains the condition.
 */
const CONTEXT_AT_RULES = new Set([
  'media',
  'supports',
  'container',
  'layer',
  'scope',
  'document',
  'starting-style',
  'include',
  'if',
  'else',
  'each',
  'for',
  'while',
  'at-root',
]);

const AT_RULE_NAME = /^@(?:-\w+-)?([\w-]+)/;

/**
 * The indented Sass syntax, rewritten with braces and semicolons so one
 * parser serves every dialect. Each input line maps to the same output line,
 * so line numbers survive.
 */
function bracesFromIndented(source: string): string {
  const lines = source.split('\n');
  const out = lines.map(() => '');
  const indentOf = (line: string) => /^[ \t]*/.exec(line)![0].length;
  const content = (line: string) => {
    const text = line.trim();
    if (!text || text.startsWith('//') || text.startsWith('/*')) return '';
    return text
      .replace(/\s\/\/.*$/, '')
      .replace(/^=/, '@mixin ')
      .replace(/^\+/, '@include ');
  };

  const open: number[] = [];
  let last = -1;
  lines.forEach((line, i) => {
    const text = content(line);
    if (!text) return;
    const indent = indentOf(line);
    let closes = '';
    while (open.length && indent <= open[open.length - 1]) {
      open.pop();
      closes += '}';
    }
    let next = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (content(lines[j])) {
        next = indentOf(lines[j]);
        break;
      }
    }
    if (next > indent) {
      open.push(indent);
      out[i] = `${closes}${text} {`;
    } else {
      out[i] = `${closes}${text};`;
    }
    last = i;
  });
  if (last >= 0) out[last] += '}'.repeat(open.length);
  return out.join('\n');
}

/** Split a stylesheet into nested blocks and the statements between them. */
function parseBlocks(source: string, lang: Lang): Node[] {
  const root: Block = { kind: 'block', header: '', children: [], line: 1 };
  const stack: Block[] = [root];
  const lineComments = lang !== 'css';

  let buf = '';
  let bufLine = 1;
  let line = 1;
  let parens = 0;
  let quote: string | null = null;

  const append = (c: string) => {
    if (!buf.trim() && c.trim()) bufLine = line;
    buf += c;
  };
  const flushDecl = () => {
    const text = buf.trim();
    if (text) stack[stack.length - 1].children.push({ kind: 'decl', text, line: bufLine });
    buf = '';
  };

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\n') line++;

    if (quote) {
      append(c);
      if (c === '\\' && i + 1 < source.length) {
        if (source[i + 1] === '\n') line++;
        buf += source[++i];
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let j = i + 1; j < stop; j++) if (source[j] === '\n') line++;
      i = stop - 1;
      continue;
    }
    // `url(http://…)` sits inside parentheses; a line comment does not
    if (lineComments && c === '/' && source[i + 1] === '/' && parens === 0) {
      const end = source.indexOf('\n', i);
      i = (end === -1 ? source.length : end) - 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      append(c);
      continue;
    }
    if (c === '(') parens++;
    else if (c === ')') parens = Math.max(0, parens - 1);

    if (parens === 0 && c === '{') {
      const block: Block = { kind: 'block', header: buf.trim(), children: [], line: bufLine };
      stack[stack.length - 1].children.push(block);
      stack.push(block);
      buf = '';
    } else if (parens === 0 && c === '}') {
      flushDecl();
      if (stack.length > 1) stack.pop();
    } else if (parens === 0 && c === ';') {
      flushDecl();
    } else {
      append(c);
    }
  }
  flushDecl();
  return root.children;
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

/** `color : red` → `color: red`; statements such as `@include x` pass through. */
function normalizeDecl(text: string): string {
  const flat = collapse(text);
  const colon = flat.indexOf(':');
  if (colon <= 0) return flat;
  const prop = flat.slice(0, colon).trim();
  if (!/^[\w$@-]+$/.test(prop)) return flat;
  return `${prop}: ${flat.slice(colon + 1).trim()}`;
}

/** Split on commas outside parentheses, brackets, and strings. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const c of text) {
    if (quote) {
      current += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  parts.push(current);
  return parts.map(collapse).filter(Boolean);
}

/** The selector a nested rule compiles to: `&` substitutes the parent, otherwise it descends. */
function resolveSelector(parent: string | null, child: string): string {
  const children = splitTop(child);
  if (parent === null) return children.join(', ');
  const parents = splitTop(parent);
  const resolved: string[] = [];
  for (const p of parents) {
    for (const c of children) resolved.push(c.includes('&') ? c.replace(/&/g, p) : `${p} ${c}`);
  }
  return resolved.join(', ');
}

/** A block rendered on one line, for members that stand in for a whole block. */
function fold(block: Block): string {
  const inner = block.children.map((n) => (n.kind === 'decl' ? normalizeDecl(n.text) : fold(n)));
  return `${collapse(block.header)} { ${inner.join('; ')} }`;
}

/** Class names a selector exposes, leaving `:global(…)` alone. */
function classNames(selector: string): string[] {
  const local = selector.replace(/:global\([^)]*\)/g, '').replace(/:global\s+\S+/g, '');
  return [...local.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => `.${m[1]}`);
}

interface Output {
  file: string;
  lang: Lang;
  module: boolean;
  symbols: Map<string, SymbolInfo>;
  /** Normalized text per symbol, hashed once everything is collected */
  text: Map<string, string[]>;
  classes: Set<string>;
}

function upsert(
  out: Output,
  name: string,
  over: Partial<SymbolInfo> & { line: number },
  members: string[],
  text: string
): void {
  const existing = out.symbols.get(name);
  if (existing) {
    // The same selector twice describes one rule: keep collecting
    const merged = [...(existing.members ?? [])];
    for (const m of members) if (!merged.includes(m)) merged.push(m);
    if (merged.length) existing.members = merged;
    out.text.get(name)!.push(text);
    return;
  }
  const { line, ...rest } = over;
  out.symbols.set(name, {
    id: `${out.file}#${name}`,
    name,
    file: out.file,
    lang: out.lang,
    kind: 'style',
    export: out.module ? 'none' : 'named',
    ...(members.length ? { members } : {}),
    edges: [],
    bodyHash: '',
    line,
    ...rest,
  });
  out.text.set(name, [text]);
}

/** `@keyframes spin`, `@font-face`, `@mixin button($size)`: a declaration of its own. */
function emitAtRule(out: Output, block: Block, atRule: string): void {
  const header = collapse(block.header);
  const decls = block.children.filter((n): n is Decl => n.kind === 'decl');
  const members = block.children.map((n) => (n.kind === 'decl' ? normalizeDecl(n.text) : fold(n)));

  let name = header;
  let signature: string | undefined;
  let exported: SymbolInfo['export'] | undefined;
  if (atRule === 'mixin' || atRule === 'function') {
    const m = /^(@[\w-]+\s+[\w-]+)\s*(\(.*\))?$/.exec(header);
    if (m) {
      name = m[1];
      signature = m[2] ? collapse(m[2]) : undefined;
    }
    exported = 'named'; // reachable through @use/@import whatever the file
  } else if (atRule === 'font-face') {
    const value = (prop: string) =>
      decls
        .map((d) => normalizeDecl(d.text))
        .find((d) => d.startsWith(`${prop}:`))
        ?.slice(prop.length + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
    name = [header, value('font-family'), value('font-weight'), value('font-style')]
      .filter(Boolean)
      .join(' ');
  }

  upsert(
    out,
    name,
    {
      line: block.line,
      role: [atRule],
      ...(signature ? { signature } : {}),
      ...(exported ? { export: exported } : {}),
    },
    members,
    fold(block)
  );
}

/** A rule: its own declarations become members; nested rules become symbols of their own. */
function emitRule(out: Output, block: Block, selector: string, contexts: string[]): void {
  const members: string[] = [];
  for (const node of block.children) {
    if (node.kind === 'decl') {
      members.push(normalizeDecl(node.text));
      continue;
    }
    const header = collapse(node.header);
    const at = AT_RULE_NAME.exec(header);
    if (at) {
      if (CONTEXT_AT_RULES.has(at[1])) emitRule(out, node, selector, [...contexts, header]);
      else emitAtRule(out, node, at[1]);
    } else if (/^[\w-]+\s*:$/.test(header)) {
      // Sass nested properties: `font: { family: x }` is `font-family: x`
      const prefix = header.slice(0, -1).trim();
      for (const child of node.children) {
        if (child.kind === 'decl') members.push(`${prefix}-${normalizeDecl(child.text)}`);
      }
    } else {
      emitRule(out, node, resolveSelector(selector, header), contexts);
    }
  }

  for (const cls of classNames(selector)) out.classes.add(cls);
  if (members.length === 0) return; // only a wrapper around nested rules
  const name = [selector, ...contexts].join(' ');
  upsert(out, name, { line: block.line }, members, `${name} { ${members.join('; ')} }`);
}

/** `$spacing: 8px` (Sass) or `@primary: #333` (Less) at the top level. */
function emitVariable(out: Output, decl: Decl): boolean {
  const pattern = out.lang === 'less' ? /^@([\w-]+)\s*:\s*(.+)$/s : /^\$([\w-]+)\s*:\s*(.+)$/s;
  const m = pattern.exec(decl.text.trim());
  if (!m || (out.lang !== 'less' && out.lang !== 'scss' && out.lang !== 'sass')) return false;
  const sigil = out.lang === 'less' ? '@' : '$';
  const value = collapse(m[2]);
  upsert(
    out,
    `${sigil}${m[1]}`,
    { line: decl.line, role: ['variable'], export: 'named', signature: value },
    [],
    `${sigil}${m[1]}: ${value}`
  );
  return true;
}

function emitTopLevel(out: Output, nodes: Node[], contexts: string[]): void {
  for (const node of nodes) {
    if (node.kind === 'decl') {
      // `@use`, `@import`, `@tailwind`: statements that declare nothing here
      emitVariable(out, node);
      continue;
    }
    const header = collapse(node.header);
    const at = AT_RULE_NAME.exec(header);
    if (at) {
      if (CONTEXT_AT_RULES.has(at[1])) emitTopLevel(out, node.children, [...contexts, header]);
      else emitAtRule(out, node, at[1]);
    } else if (!/^[\w-]+\s*:$/.test(header)) {
      emitRule(out, node, resolveSelector(null, header), contexts);
    }
  }
}

/** Every rule, variable, mixin, and at-rule declaration in a stylesheet. */
export function analyzeStyles(absFile: string, relFile: string): FileAnalysis {
  const lang = LANG_BY_EXT.get(path.extname(relFile)) ?? 'css';
  const raw = fs.readFileSync(absFile, 'utf8');
  const base = path.basename(relFile);

  // A minified bundle is not something anyone reviews rule by rule
  if (/\.min\.[a-z]+$/.test(base)) {
    const name = base.replace(/\.min\.[a-z]+$/, '');
    return {
      file: relFile,
      symbols: [
        {
          id: `${relFile}#${name}`,
          name,
          file: relFile,
          lang,
          kind: 'module',
          export: 'named',
          role: ['minified'],
          edges: [],
          bodyHash: hashOf(raw),
        },
      ],
      imports: [],
      reexports: [],
    };
  }

  const source = lang === 'sass' ? bracesFromIndented(raw) : raw;
  const out: Output = {
    file: relFile,
    lang,
    module: MODULE_FILE.test(base),
    symbols: new Map(),
    text: new Map(),
    classes: new Set(),
  };
  emitTopLevel(out, parseBlocks(source, lang), []);

  const symbols = [...out.symbols.values()];
  for (const sym of symbols) sym.bodyHash = hashOf(out.text.get(sym.name)!.join('\n'));

  if (out.module) {
    const name = base.replace(MODULE_FILE, '');
    const classes = [...out.classes].sort();
    symbols.unshift({
      id: `${relFile}#${name}`,
      name,
      file: relFile,
      lang,
      kind: 'style',
      export: 'default',
      role: ['module'],
      ...(classes.length ? { members: classes } : {}),
      edges: [],
      bodyHash: hashOf(classes.join('\n')),
      line: 1,
    });
  }

  return { file: relFile, symbols, imports: [], reexports: [] };
}
