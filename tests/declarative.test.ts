import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeFile } from '../src/analyze';
import { summarizeStatement } from '../src/extractors/sql';
import { linkSymbols } from '../src/resolve';
import { analyzeProject } from '../src/snap';
import { edgesOf, SymbolInfo } from '../src/types';
import { cleanup, makeProject } from './helpers';

const SCHEMA = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Tier {
  LOW
  HIGH
}

model Company {
  id        String   @id @default(cuid())
  name      String   @default("")
  tier      Int      @default(3)
  // a comment that should not become a field
  createdBy User     @relation(fields: [createdById], references: [id])
  createdById String
  roles     Role[]

  @@index([createdById, name])
}

model User {
  id       String    @id
  companies Company[]
}
`;

const MIGRATION = `-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "tier" INTEGER NOT NULL DEFAULT 3,
    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- AddColumn
ALTER TABLE "Artifact" ADD COLUMN "roleId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Company_name_key" ON "Company"("name");
`;

const ENV = `# Local only
DATABASE_URL=postgresql://user:hunter2@localhost:5432/db
BETTER_AUTH_SECRET=replace-me
# commented=NOPE
EMPTY=
`;

const COMPOSE = `services:
  postgres:
    image: postgres:17-alpine
    ports:
      - "5432:5432"
  cache:
    image: redis:7
`;

const PACKAGE = JSON.stringify({
  name: 'scratch',
  private: true,
  scripts: { build: 'tsc', test: 'vitest run' },
  dependencies: { react: '^19.0.0' },
  devDependencies: { typescript: '^5.5.0' },
});

let root: string;
const analyze = (rel: string) => analyzeFile(path.join(root, rel), rel);
const byName = (symbols: SymbolInfo[], name: string) => {
  const s = symbols.find((x) => x.name === name);
  if (!s) throw new Error(`no symbol ${name} in [${symbols.map((x) => x.name)}]`);
  return s;
};

beforeAll(() => {
  root = makeProject({
    'package.json': PACKAGE,
    'prisma/schema.prisma': SCHEMA,
    'prisma/migrations/20260101000000_init/migration.sql': MIGRATION,
    '.env.example': ENV,
    'compose.yaml': COMPOSE,
  });
});

afterAll(() => cleanup(root));

describe('prisma schema', () => {
  const symbols = () => analyze('prisma/schema.prisma').symbols;

  it('records models, enums, and configuration blocks', () => {
    expect(symbols().map((s) => `${s.kind}:${s.name}`)).toEqual([
      'config:db',
      'type:Tier',
      'model:Company',
      'model:User',
    ]);
  });

  it('records fields with their types, and block attributes', () => {
    expect(byName(symbols(), 'Company').members).toEqual([
      'id: String',
      'name: String',
      'tier: Int',
      'createdBy: User',
      'createdById: String',
      'roles: Role[]',
      '@@index([createdById, name])',
    ]);
  });

  it('ignores comment lines inside a model', () => {
    expect(byName(symbols(), 'Company').members?.join(' ')).not.toContain('comment');
  });

  it('records enum values and datasource settings', () => {
    expect(byName(symbols(), 'Tier').members).toEqual(['LOW', 'HIGH']);
    expect(byName(symbols(), 'db').members).toEqual([
      'provider = "postgresql"',
      'url = env("DATABASE_URL")',
    ]);
  });

  it('links relation fields to the models they reference', () => {
    const { symbols: linked } = linkSymbols(root, [analyze('prisma/schema.prisma')]);
    const company = byName(linked, 'Company');
    const refs = edgesOf(company, 'references');
    expect(refs.map((e) => e.name)).toEqual(['User', 'Role']);
    expect(refs[0].id).toBe('prisma/schema.prisma#User');
    // Role has no model block here, so it stays unresolved rather than guessing
    expect(refs[1].id).toBeUndefined();
  });

  it('treats models as part of the public surface', () => {
    expect(byName(symbols(), 'Company').export).toBe('named');
    expect(byName(symbols(), 'db').export).toBe('none');
  });
});

describe('sql migrations', () => {
  it('summarizes statements down to one readable line each', () => {
    expect(summarizeStatement('CREATE TABLE "Company" ("id" TEXT NOT NULL)')).toBe(
      'CREATE TABLE "Company"'
    );
    expect(summarizeStatement('ALTER TABLE "Artifact" ADD COLUMN "roleId" TEXT')).toBe(
      'ALTER TABLE "Artifact" ADD COLUMN "roleId"'
    );
    expect(summarizeStatement('CREATE UNIQUE INDEX "x" ON "Company"("name")')).toBe(
      'CREATE UNIQUE INDEX "x"'
    );
    expect(summarizeStatement('   ')).toBeNull();
  });

  it('names the symbol after the migration directory', () => {
    const [sym] = analyze('prisma/migrations/20260101000000_init/migration.sql').symbols;
    expect(sym).toMatchObject({ kind: 'migration', name: '20260101000000_init', lang: 'sql' });
    expect(sym.members).toEqual([
      'CREATE TABLE "Company"',
      'ALTER TABLE "Artifact" ADD COLUMN "roleId"',
      'CREATE UNIQUE INDEX "Company_name_key"',
    ]);
  });
});

describe('configuration files', () => {
  it('splits package.json into scripts and dependency sections', () => {
    const symbols = analyze('package.json').symbols;
    expect(symbols.map((s) => s.name)).toEqual(['scripts', 'dependencies', 'devDependencies']);
    expect(byName(symbols, 'scripts').members).toEqual(['build: tsc', 'test: vitest run']);
    expect(byName(symbols, 'dependencies').members).toEqual(['react@^19.0.0']);
  });

  it('records env variable names and never their values', () => {
    const [sym] = analyze('.env.example').symbols;
    expect(sym.members).toEqual([
      'DATABASE_URL',
      'BETTER_AUTH_SECRET',
      'EMPTY',
    ]);
    const serialized = JSON.stringify(sym);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('replace-me');
  });

  it('records one symbol per compose service', () => {
    const symbols = analyze('compose.yaml').symbols;
    expect(symbols.map((s) => s.name)).toEqual(['postgres', 'cache']);
    expect(byName(symbols, 'postgres').members).toEqual(['image: postgres:17-alpine', 'ports']);
  });
});

describe('project scan', () => {
  it('picks up every declarative file alongside the code', async () => {
    const analysis = await analyzeProject(root);
    const kinds = new Set(analysis.symbols.map((s) => s.kind));
    expect([...kinds].sort()).toEqual(['config', 'migration', 'model', 'type']);
    const langs = new Set(analysis.symbols.map((s) => s.lang));
    expect([...langs].sort()).toEqual(['env', 'json', 'prisma', 'sql', 'yaml']);
  });
});
