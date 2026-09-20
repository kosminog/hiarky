import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { FileAnalysis, SymbolInfo } from '../types';

export const SQL_GLOBS = ['**/*.sql'];

export function matchesSql(file: string): boolean {
  return file.endsWith('.sql');
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

const LEAD = /^(CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE|COMMENT|GRANT|REVOKE)\b/i;
const OBJECT =
  /^(CREATE|ALTER|DROP)\s+(?:(UNIQUE|OR REPLACE)\s+)?(TABLE|INDEX|TYPE|VIEW|SCHEMA|SEQUENCE|FUNCTION|TRIGGER|EXTENSION|DATABASE)\s+(?:IF (?:NOT )?EXISTS\s+)?("[^"]+"|[\w.]+)/i;
const ALTER_ACTION =
  /\b(ADD COLUMN|DROP COLUMN|ALTER COLUMN|ADD CONSTRAINT|DROP CONSTRAINT|RENAME COLUMN|RENAME TO)\s+("[^"]+"|[\w.]+)?/i;

/** One readable line per statement: `ALTER TABLE "Artifact" ADD COLUMN "roleId"`. */
export function summarizeStatement(statement: string): string | null {
  const clean = statement.replace(/\s+/g, ' ').trim();
  if (!clean || !LEAD.test(clean)) return null;

  const obj = OBJECT.exec(clean);
  if (!obj) return clean.slice(0, 60);

  const [, verb, qualifier, objectType, name] = obj;
  let summary = [verb.toUpperCase(), qualifier?.toUpperCase(), objectType.toUpperCase(), name]
    .filter(Boolean)
    .join(' ');

  if (verb.toUpperCase() === 'ALTER') {
    const action = ALTER_ACTION.exec(clean);
    if (action) summary += ` ${action[1].toUpperCase()}${action[2] ? ' ' + action[2] : ''}`;
  }
  return summary;
}

/** Strip `--` line comments and `/* *\/` block comments, preserving strings. */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Record each SQL file as one migration symbol summarizing its statements.
 *
 * Migrations are append-only and change shared state, so what matters for
 * review is that a new one appeared and what it does to the schema.
 */
export function analyzeSql(absFile: string, relFile: string): FileAnalysis {
  const source = fs.readFileSync(absFile, 'utf8');
  const base = path.basename(relFile, '.sql');
  // prisma/migrations/<timestamp>_<name>/migration.sql — the directory is the name
  const name = base === 'migration' ? path.basename(path.dirname(relFile)) : base;

  const members: string[] = [];
  for (const statement of stripSqlComments(source).split(';')) {
    const summary = summarizeStatement(statement);
    if (summary) members.push(summary);
  }

  return {
    file: relFile,
    symbols: [
      {
        id: `${relFile}#${name}`,
        name,
        file: relFile,
        lang: 'sql',
        kind: 'migration',
        export: 'none',
        ...(members.length ? { members } : {}),
        edges: [],
        bodyHash: hashOf(source),
      },
    ],
    imports: [],
    reexports: [],
  };
}
