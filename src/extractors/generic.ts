import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { FileAnalysis, Lang, SymbolInfo, SymbolKind } from '../types';

/**
 * A declaration scanner for languages without a dedicated extractor.
 *
 * It reads top-level declarations only, and records no call graph: the point
 * is that a Go or Swift file is not invisible to a review, not that it is
 * understood as deeply as TypeScript or Python. Anything needing more should
 * get its own extractor behind the same interface.
 */

interface Pattern {
  /** Applied to a trimmed line at nesting depth 0 */
  re: RegExp;
  kind: SymbolKind;
  /** Capture group holding the name */
  name: number;
  /** Capture group holding an owning type, for methods */
  owner?: number;
  /** Capture group whose presence marks the declaration exported */
  visibility?: number;
  /** Does this declaration open a body whose members are worth collecting? */
  container?: boolean;
}

interface LangSpec {
  lang: Lang;
  extensions: string[];
  patterns: Pattern[];
  /** Member declarations, matched one level inside a container */
  member?: RegExp;
  /** Exported when the name starts with a capital (Go) */
  capitalIsPublic?: boolean;
  /** Line comment marker, stripped before matching */
  comment: string;
}

const SPECS: LangSpec[] = [
  {
    lang: 'go',
    extensions: ['.go'],
    comment: '//',
    capitalIsPublic: true,
    patterns: [
      { re: /^func\s+\(\s*\w+\s+\*?([A-Za-z_]\w*)\s*\)\s*([A-Za-z_]\w*)/, kind: 'method', name: 2, owner: 1 },
      { re: /^func\s+([A-Za-z_]\w*)\s*[(\[]/, kind: 'function', name: 1 },
      { re: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, kind: 'class', name: 1, container: true },
      { re: /^type\s+([A-Za-z_]\w*)\s+\S/, kind: 'type', name: 1 },
      { re: /^(?:var|const)\s+([A-Za-z_]\w*)/, kind: 'const', name: 1 },
    ],
    member: /^([A-Za-z_]\w*)\s+[\w*[\]().]/,
  },
  {
    lang: 'rust',
    extensions: ['.rs'],
    comment: '//',
    patterns: [
      { re: /^(pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function', name: 2, visibility: 1 },
      { re: /^(pub(?:\([^)]*\))?\s+)?(?:struct|enum|union)\s+([A-Za-z_]\w*)/, kind: 'class', name: 2, visibility: 1, container: true },
      { re: /^(pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: 'type', name: 2, visibility: 1, container: true },
      { re: /^(pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/, kind: 'type', name: 2, visibility: 1 },
      { re: /^(pub(?:\([^)]*\))?\s+)?(?:static|const)\s+([A-Za-z_]\w*)/, kind: 'const', name: 2, visibility: 1 },
      { re: /^impl(?:<[^>]*>)?\s+(?:[A-Za-z_][\w:<>, ]*\s+for\s+)?([A-Za-z_]\w*)/, kind: 'class', name: 1, container: true },
    ],
    member: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
  },
  {
    lang: 'java',
    extensions: ['.java'],
    comment: '//',
    patterns: [
      { re: /^(public\s+)?(?:final\s+|abstract\s+|sealed\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/, kind: 'class', name: 2, visibility: 1, container: true },
    ],
    member: /^(?:public|protected|private)?\s*(?:static\s+|final\s+|synchronized\s+)*[\w<>,\[\]. ]+\s+([A-Za-z_]\w*)\s*\(/,
  },
  {
    lang: 'kotlin',
    extensions: ['.kt', '.kts'],
    comment: '//',
    patterns: [
      { re: /^(?:(private|internal)\s+)?(?:data\s+|sealed\s+|open\s+|abstract\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/, kind: 'class', name: 2, container: true },
      { re: /^(?:(private|internal)\s+)?(?:suspend\s+)?fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/, kind: 'function', name: 2 },
      { re: /^(?:(private|internal)\s+)?(?:const\s+)?(?:val|var)\s+([A-Za-z_]\w*)/, kind: 'const', name: 2 },
    ],
    member: /^(?:[\w@]+\s+)*fun\s+([A-Za-z_]\w*)/,
  },
  {
    lang: 'csharp',
    extensions: ['.cs'],
    comment: '//',
    patterns: [
      { re: /^(public\s+)?(?:static\s+|sealed\s+|abstract\s+|partial\s+)*(?:class|interface|struct|record|enum)\s+([A-Za-z_]\w*)/, kind: 'class', name: 2, visibility: 1, container: true },
    ],
    member: /^(?:public|internal|protected|private)?\s*(?:static\s+|async\s+|virtual\s+|override\s+)*[\w<>,\[\]. ?]+\s+([A-Za-z_]\w*)\s*\(/,
  },
  {
    lang: 'swift',
    extensions: ['.swift'],
    comment: '//',
    patterns: [
      { re: /^(?:(public|open)\s+)?(?:final\s+)?(?:class|struct|enum|protocol|actor)\s+([A-Za-z_]\w*)/, kind: 'class', name: 2, visibility: 1, container: true },
      { re: /^(?:(public|open)\s+)?(?:static\s+)?func\s+([A-Za-z_]\w*)/, kind: 'function', name: 2, visibility: 1 },
      { re: /^(?:(public|open)\s+)?(?:let|var)\s+([A-Za-z_]\w*)/, kind: 'const', name: 2, visibility: 1 },
    ],
    member: /^(?:[\w@]+\s+)*func\s+([A-Za-z_]\w*)/,
  },
  {
    lang: 'php',
    extensions: ['.php'],
    comment: '//',
    patterns: [
      { re: /^(?:abstract\s+|final\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/, kind: 'class', name: 1, container: true },
      { re: /^function\s+([A-Za-z_]\w*)\s*\(/, kind: 'function', name: 1 },
    ],
    member: /^(?:public|protected|private)?\s*(?:static\s+)?function\s+([A-Za-z_]\w*)/,
  },
  {
    lang: 'sh',
    extensions: ['.sh', '.bash'],
    comment: '#',
    patterns: [
      { re: /^function\s+([A-Za-z_][\w-]*)\s*(?:\(\))?\s*\{/, kind: 'function', name: 1 },
      { re: /^([A-Za-z_][\w-]*)\s*\(\)\s*\{/, kind: 'function', name: 1 },
      { re: /^(?:export\s+|readonly\s+)?([A-Z_][A-Z0-9_]*)=/, kind: 'const', name: 1 },
    ],
  },
];

const BY_EXTENSION = new Map<string, LangSpec>();
for (const spec of SPECS) {
  for (const ext of spec.extensions) BY_EXTENSION.set(ext, spec);
}

export const GENERIC_GLOBS = [...BY_EXTENSION.keys()].map((ext) => `**/*${ext}`);

export function matchesGeneric(file: string): boolean {
  return BY_EXTENSION.has(path.extname(file));
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function countBraces(line: string): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inString = c;
    else if (c === '{' || c === '(' || c === '[') {
      if (c === '{') depth++;
    } else if (c === '}') depth--;
  }
  return depth;
}

/** Top-level declarations in a language without a dedicated extractor. */
export function analyzeGeneric(absFile: string, relFile: string): FileAnalysis {
  const spec = BY_EXTENSION.get(path.extname(relFile));
  if (!spec) return { file: relFile, symbols: [], imports: [], reexports: [] };

  const lines = fs.readFileSync(absFile, 'utf8').split('\n');
  const symbols: SymbolInfo[] = [];
  const seen = new Set<string>();

  let depth = 0;
  let open: {
    symbol: SymbolInfo;
    startLine: number;
    members: string[];
    container: boolean;
  } | null = null;
  const byName = new Map<string, SymbolInfo>();

  lines.forEach((raw, index) => {
    const commentAt = raw.indexOf(spec.comment);
    const code = (commentAt === -1 ? raw : raw.slice(0, commentAt)).trim();
    const delta = countBraces(code);

    if (depth === 0 && code) {
      for (const pattern of spec.patterns) {
        const match = pattern.re.exec(code);
        if (!match) continue;
        const bare = match[pattern.name];
        if (!bare) continue;
        const name = pattern.owner && match[pattern.owner] ? `${match[pattern.owner]}.${bare}` : bare;
        if (seen.has(name)) {
          // `impl Foo { … }` after `struct Foo` describes the same symbol:
          // keep collecting its methods instead of dropping the block.
          const existing = byName.get(name);
          if (pattern.container && existing && delta > 0) {
            open = {
              symbol: existing,
              startLine: index,
              members: existing.members ? [...existing.members] : [],
              container: true,
            };
          }
          break;
        }
        seen.add(name);

        const exported = spec.capitalIsPublic
          ? /^[A-Z]/.test(bare)
          : pattern.visibility !== undefined
            ? Boolean(match[pattern.visibility])
            : !bare.startsWith('_');

        const symbol: SymbolInfo = {
          id: `${relFile}#${name}`,
          name,
          file: relFile,
          lang: spec.lang,
          kind: pattern.kind,
          export: exported ? 'named' : 'none',
          signature: code.replace(/\s*\{\s*$/, '').slice(0, 200),
          edges: [],
          bodyHash: hashOf(code),
          line: index + 1,
        };
        symbols.push(symbol);
        byName.set(name, symbol);
        if (delta > 0) {
          open = {
            symbol,
            startLine: index,
            members: [],
            // Only a type body has members; a function body has statements
            container: Boolean(pattern.container),
          };
        }
        break;
      }
    } else if (open?.container && depth === 1 && code && spec.member) {
      const match = spec.member.exec(code);
      if (match?.[1] && !open.members.includes(match[1])) open.members.push(match[1]);
    }

    depth += delta;
    if (open && depth <= 0) {
      // Hash the whole declaration so body edits are visible
      open.symbol.bodyHash = hashOf(lines.slice(open.startLine, index + 1).join('\n'));
      if (open.members.length) open.symbol.members = open.members;
      else delete open.symbol.members;
      open = null;
      depth = 0;
    }
  });

  return { file: relFile, symbols, imports: [], reexports: [] };
}
