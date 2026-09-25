import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { Edge, FileAnalysis, ImportBinding, SymbolInfo, SymbolKind } from '../types';
import { PYTHON_AST_SCRIPT } from './python-script';

export const PYTHON_GLOBS = ['**/*.py'];

export function matchesPython(file: string): boolean {
  return file.endsWith('.py');
}

/** Files per interpreter run; keeps the argument list well inside any limit. */
const CHUNK = 150;

interface RawSymbol {
  name: string;
  kind: string;
  export: SymbolInfo['export'];
  bodyHash: string;
  line?: number;
  signature?: string;
  route?: string;
  role?: string[];
  members?: string[];
  edges?: Array<{ kind: string; name: string }>;
}

interface RawFile {
  file: string;
  imports: ImportBinding[];
  symbols: RawSymbol[];
  error: string | null;
}

let interpreter: string | null | undefined;

/** The first working Python 3 on PATH, or null. Probed once per process. */
export function pythonCommand(): string | null {
  if (interpreter !== undefined) return interpreter;
  for (const candidate of ['python3', 'python']) {
    try {
      const version = execFileSync(candidate, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .toString()
        .trim();
      if (/Python 3\./.test(version)) {
        interpreter = candidate;
        return interpreter;
      }
    } catch {
      // try the next candidate
    }
  }
  interpreter = null;
  return interpreter;
}

/** Test seam: forget the probed interpreter. */
export function resetPythonCommand(): void {
  interpreter = undefined;
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * When Python is unavailable or the file will not parse, still record that the
 * file exists and whether it changed — a hash-only symbol is far more useful
 * to a reviewer than the file silently disappearing from the snapshot.
 */
function fallbackAnalysis(absFile: string, relFile: string, reason: string): FileAnalysis {
  let source = '';
  try {
    source = fs.readFileSync(absFile, 'utf8');
  } catch {
    // unreadable; an empty hash still marks its presence
  }
  const name = path.basename(relFile, '.py');
  return {
    file: relFile,
    symbols: [
      {
        id: `${relFile}#${name}`,
        name,
        file: relFile,
        lang: 'py',
        kind: 'module',
        export: 'named',
        edges: [],
        bodyHash: hashOf(source),
      },
    ],
    imports: [],
    reexports: [],
    parseError: reason,
  };
}

const KINDS: Record<string, SymbolKind> = {
  function: 'function',
  class: 'class',
  const: 'const',
  route: 'route',
  module: 'module',
};

function toFileAnalysis(raw: RawFile, relFile: string): FileAnalysis {
  const symbols: SymbolInfo[] = raw.symbols.map((s) => {
    const edges: Edge[] = (s.edges ?? [])
      .filter((e) => ['calls', 'extends', 'references'].includes(e.kind))
      .map((e) => ({ kind: e.kind as Edge['kind'], name: e.name }));
    return {
      id: `${relFile}#${s.name}`,
      name: s.name,
      file: relFile,
      lang: 'py',
      kind: KINDS[s.kind] ?? 'function',
      export: s.export,
      ...(s.signature ? { signature: s.signature } : {}),
      ...(s.route ? { route: s.route } : {}),
      ...(s.role?.length ? { role: s.role } : {}),
      ...(s.members?.length ? { members: s.members } : {}),
      edges,
      bodyHash: s.bodyHash,
      ...(s.line ? { line: s.line } : {}),
    };
  });

  return {
    file: relFile,
    symbols,
    imports: raw.imports,
    reexports: [],
    ...(raw.error ? { parseError: raw.error } : {}),
  };
}

/**
 * Analyze Python files with the interpreter's own `ast` module.
 *
 * One interpreter run covers the whole batch: spawning python per file costs
 * more than the parsing does.
 */
export function analyzePythonMany(
  files: Array<{ abs: string; rel: string }>
): FileAnalysis[] {
  if (files.length === 0) return [];
  const python = pythonCommand();
  if (!python) {
    return files.map((f) =>
      fallbackAnalysis(f.abs, f.rel, 'python3 not found on PATH; recorded file hash only')
    );
  }

  const out: FileAnalysis[] = [];
  for (let i = 0; i < files.length; i += CHUNK) {
    const batch = files.slice(i, i + CHUNK);
    let parsed: RawFile[];
    try {
      const stdout = execFileSync(
        python,
        ['-c', PYTHON_AST_SCRIPT, ...batch.map((f) => f.abs)],
        { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }
      ).toString();
      parsed = JSON.parse(stdout) as RawFile[];
    } catch (err) {
      const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
      for (const f of batch) out.push(fallbackAnalysis(f.abs, f.rel, `python analysis failed: ${reason}`));
      continue;
    }
    batch.forEach((f, idx) => {
      const raw = parsed[idx];
      if (!raw) {
        out.push(fallbackAnalysis(f.abs, f.rel, 'no result for this file'));
        return;
      }
      // A file that would not parse still gets a hash-only symbol, so a
      // reviewer sees it changed rather than seeing it vanish.
      if (raw.error && raw.symbols.length === 0) {
        out.push(fallbackAnalysis(f.abs, f.rel, raw.error));
        return;
      }
      out.push(toFileAnalysis(raw, f.rel));
    });
  }
  return out;
}

export function analyzePython(absFile: string, relFile: string): FileAnalysis {
  return analyzePythonMany([{ abs: absFile, rel: relFile }])[0];
}
