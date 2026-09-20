import * as fs from 'fs';
import { createHash } from 'crypto';
import { Edge, FileAnalysis, SymbolInfo } from '../types';

export const PRISMA_GLOBS = ['**/*.prisma'];

export function matchesPrisma(file: string): boolean {
  return file.endsWith('.prisma');
}

/** Field types that are not references to another model. */
const SCALARS = new Set([
  'String',
  'Boolean',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Json',
  'Bytes',
  'Unsupported',
]);

const BLOCK = /^(model|enum|datasource|generator|type|view)\s+([A-Za-z_][\w]*)\s*\{/;

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function stripComment(line: string): string {
  const idx = line.indexOf('//');
  return (idx === -1 ? line : line.slice(0, idx)).trim();
}

/**
 * Parse a Prisma schema into model, enum, and configuration symbols.
 *
 * A field added to a model is the single highest-signal change a reviewer can
 * see — it implies a migration, an API change, and usually a UI change — so
 * models are recorded field by field rather than as one opaque blob.
 */
export function analyzePrisma(absFile: string, relFile: string): FileAnalysis {
  const source = fs.readFileSync(absFile, 'utf8');
  const lines = source.split('\n');
  const symbols: SymbolInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = BLOCK.exec(lines[i].trim());
    if (!match) continue;
    const [, blockType, name] = match;

    // Collect the block body, tracking braces so nested types do not end it early
    const bodyLines: string[] = [];
    let depth = 1;
    let j = i;
    while (++j < lines.length && depth > 0) {
      const line = lines[j];
      depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
      if (depth > 0) bodyLines.push(line);
    }
    const blockSource = lines.slice(i, j).join('\n');
    i = j - 1;

    const members: string[] = [];
    const edges: Edge[] = [];

    for (const raw of bodyLines) {
      const line = stripComment(raw);
      if (!line) continue;

      if (line.startsWith('@@')) {
        members.push(line.replace(/\s+/g, ' ')); // @@index([a, b]), @@unique(...)
        continue;
      }

      if (blockType === 'enum') {
        members.push(line.split(/\s+/)[0]);
        continue;
      }

      if (blockType === 'datasource' || blockType === 'generator') {
        const [key, ...rest] = line.split('=');
        if (rest.length) members.push(`${key.trim()} = ${rest.join('=').trim()}`);
        continue;
      }

      const [field, type] = line.split(/\s+/);
      if (!field || !type) continue;
      members.push(`${field}: ${type}`);

      const bare = type.replace(/[?[\]]/g, '');
      if (!SCALARS.has(bare) && /^[A-Z]/.test(bare)) {
        if (!edges.some((e) => e.name === bare)) {
          edges.push({ kind: 'references', name: bare });
        }
      }
    }

    const kind =
      blockType === 'model' || blockType === 'view'
        ? 'model'
        : blockType === 'enum' || blockType === 'type'
          ? 'type'
          : 'config';

    symbols.push({
      id: `${relFile}#${name}`,
      name,
      file: relFile,
      lang: 'prisma',
      kind,
      // Models and enums are referenced by name across the codebase; a
      // datasource or generator block is configuration nothing imports.
      export: kind === 'config' ? 'none' : 'named',
      role: [blockType],
      ...(members.length ? { members } : {}),
      edges,
      bodyHash: hashOf(blockSource),
    });
  }

  return { file: relFile, symbols, imports: [], reexports: [] };
}
