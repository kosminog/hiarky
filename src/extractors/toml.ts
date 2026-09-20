import { Lang, SymbolInfo } from '../types';

/**
 * A minimal TOML reader for configuration review: section headers, scalar
 * assignments, and string arrays (multi-line included).
 *
 * Deliberately not a full TOML parser — the goal is to see that a dependency
 * was added or a tool setting changed, not to evaluate the document.
 */
export interface TomlSection {
  /** Dotted section path, e.g. "project" or "tool.ruff"; "" for the preamble */
  name: string;
  /** Scalar assignments as `key = value` */
  scalars: string[];
  /** Array-valued keys, each with its elements */
  arrays: Array<{ key: string; values: string[] }>;
}

function unquote(value: string): string {
  const trimmed = value.trim().replace(/,$/, '').trim();
  const quoted = /^(['"])(.*)\1$/.exec(trimmed);
  return quoted ? quoted[2] : trimmed;
}

function stripComment(line: string): string {
  // Only comments that start a line or follow whitespace, so URLs survive
  let inString: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === inString) inString = null;
    } else if (c === '"' || c === "'") {
      inString = c;
    } else if (c === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

export function parseToml(source: string): TomlSection[] {
  const sections: TomlSection[] = [];
  let current: TomlSection = { name: '', scalars: [], arrays: [] };
  sections.push(current);

  let pendingKey: string | null = null;
  let pendingValues: string[] = [];

  const lines = source.split('\n');
  for (const raw of lines) {
    const line = stripComment(raw).trim();
    if (!line) continue;

    if (pendingKey !== null) {
      const done = line.includes(']');
      for (const piece of line.replace(/]\s*$/, '').split(',')) {
        const value = unquote(piece);
        if (value) pendingValues.push(value);
      }
      if (done) {
        current.arrays.push({ key: pendingKey, values: pendingValues });
        pendingKey = null;
        pendingValues = [];
      }
      continue;
    }

    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      current = { name: header[1].trim(), scalars: [], arrays: [] };
      sections.push(current);
      continue;
    }

    const assignment = /^([A-Za-z0-9_.\-"']+)\s*=\s*(.*)$/.exec(line);
    if (!assignment) continue;
    const key = unquote(assignment[1]);
    const value = assignment[2].trim();

    if (value.startsWith('[')) {
      const inline = value.endsWith(']');
      const body = value.slice(1, inline ? -1 : undefined);
      const values = body
        .split(',')
        .map(unquote)
        .filter((v) => v.length > 0);
      if (inline) current.arrays.push({ key, values });
      else {
        pendingKey = key;
        pendingValues = values;
      }
      continue;
    }

    current.scalars.push(`${key} = ${unquote(value)}`);
  }

  return sections.filter((s) => s.scalars.length > 0 || s.arrays.length > 0);
}

/**
 * Sections become one symbol each, and every array key (dependency lists,
 * most importantly) becomes a symbol of its own so additions and removals
 * read one per line.
 */
export function tomlSymbols(
  sections: TomlSection[],
  relFile: string,
  lang: Lang,
  hashOf: (text: string) => string
): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const add = (name: string, members: string[], role: string[]) => {
    if (members.length === 0) return;
    symbols.push({
      id: `${relFile}#${name}`,
      name,
      file: relFile,
      lang,
      kind: 'config',
      export: 'none',
      role,
      members,
      edges: [],
      bodyHash: hashOf(members.join('\n')),
    });
  };

  for (const section of sections) {
    const prefix = section.name ? `${section.name}.` : '';
    add(section.name || 'root', section.scalars, ['toml']);
    for (const array of section.arrays) {
      add(`${prefix}${array.key}`, array.values, ['toml']);
    }
  }
  return symbols;
}
