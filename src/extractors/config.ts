import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as yaml from 'js-yaml';
import { FileAnalysis, Lang, SymbolInfo } from '../types';
import { parseToml, tomlSymbols } from './toml';

export const CONFIG_GLOBS = [
  '**/package.json',
  '**/pyproject.toml',
  '**/Cargo.toml',
  '**/.env.example',
  '**/.env.sample',
  '**/compose.{yaml,yml}',
  '**/docker-compose.{yaml,yml}',
];

const COMPOSE_NAMES = new Set([
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
]);

const TOML_NAMES = new Set(['pyproject.toml', 'Cargo.toml']);

export function matchesConfig(file: string): boolean {
  const base = path.basename(file);
  return (
    base === 'package.json' ||
    base === '.env.example' ||
    base === '.env.sample' ||
    TOML_NAMES.has(base) ||
    COMPOSE_NAMES.has(base)
  );
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function symbol(
  relFile: string,
  name: string,
  lang: Lang,
  members: string[],
  source: string,
  role: string[]
): SymbolInfo {
  return {
    id: `${relFile}#${name}`,
    name,
    file: relFile,
    lang,
    kind: 'config',
    export: 'none',
    role,
    ...(members.length ? { members } : {}),
    edges: [],
    bodyHash: hashOf(source),
  };
}

/** `scripts`, `dependencies`, and `devDependencies` as one symbol each. */
function analyzePackageJson(source: string, relFile: string): SymbolInfo[] {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(source) as Record<string, unknown>;
  } catch {
    return [];
  }
  const symbols: SymbolInfo[] = [];
  const sections: Array<[string, (k: string, v: string) => string]> = [
    ['scripts', (k, v) => `${k}: ${v}`],
    ['dependencies', (k, v) => `${k}@${v}`],
    ['devDependencies', (k, v) => `${k}@${v}`],
    ['peerDependencies', (k, v) => `${k}@${v}`],
    ['optionalDependencies', (k, v) => `${k}@${v}`],
  ];

  for (const [key, format] of sections) {
    const section = pkg[key];
    if (!section || typeof section !== 'object') continue;
    const members = Object.entries(section as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => format(k, v as string));
    if (members.length === 0) continue;
    symbols.push(
      symbol(relFile, key, 'json', members, JSON.stringify(section), ['package.json'])
    );
  }
  return symbols;
}

/**
 * Environment variable names only — never their values. A `.env.example`
 * holds placeholders, but recording values would make snapshots a place
 * secrets could land the day someone points hiarky at a real `.env`.
 */
function analyzeEnvExample(source: string, relFile: string): SymbolInfo[] {
  const keys: string[] = [];
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
    if (match) keys.push(match[1]);
  }
  if (keys.length === 0) return [];
  return [symbol(relFile, 'env', 'env', keys, keys.join('\n'), ['env'])];
}

/** One symbol per compose service, with its scalar settings. */
function analyzeCompose(source: string, relFile: string): SymbolInfo[] {
  let doc: unknown;
  try {
    doc = yaml.load(source);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object') return [];
  const services = (doc as Record<string, unknown>).services;
  if (!services || typeof services !== 'object') return [];

  const symbols: SymbolInfo[] = [];
  for (const [name, config] of Object.entries(services as Record<string, unknown>)) {
    const members: string[] = [];
    if (config && typeof config === 'object') {
      for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
        if (typeof value === 'string' || typeof value === 'number') members.push(`${key}: ${value}`);
        else members.push(key);
      }
    }
    symbols.push(
      symbol(relFile, name, 'yaml', members, JSON.stringify(config ?? null), ['service'])
    );
  }
  return symbols;
}

/** Project configuration: package scripts and dependencies, env keys, services. */
export function analyzeConfig(absFile: string, relFile: string): FileAnalysis {
  const source = fs.readFileSync(absFile, 'utf8');
  const base = path.basename(relFile);

  const symbols =
    base === 'package.json'
      ? analyzePackageJson(source, relFile)
      : TOML_NAMES.has(base)
        ? tomlSymbols(parseToml(source), relFile, 'toml', hashOf)
        : COMPOSE_NAMES.has(base)
          ? analyzeCompose(source, relFile)
          : analyzeEnvExample(source, relFile);

  return { file: relFile, symbols, imports: [], reexports: [] };
}
