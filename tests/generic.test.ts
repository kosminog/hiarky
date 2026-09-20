import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeFile } from '../src/analyze';
import { analyzeProject } from '../src/snap';
import { SymbolInfo } from '../src/types';
import { cleanup, makeProject, writeFile } from './helpers';

const GO = `package main

import "fmt"

type Server struct {
	Addr string
	port int
}

type Handler interface {
	Serve() error
}

func (s *Server) Start(ctx context.Context) error {
	fmt.Println("up")
	return nil
}

func NewServer(addr string) *Server {
	return &Server{Addr: addr}
}

func internalHelper() {}

const DefaultPort = 8080
`;

const RUST = `pub struct Config {
    pub name: String,
}

impl Config {
    pub fn load(path: &str) -> Self {
        Self { name: path.into() }
    }

    fn secret(&self) -> u32 {
        1
    }
}

pub fn run(config: Config) -> Result<(), Error> {
    Ok(())
}

fn helper() {}
`;

const SHELL = `#!/usr/bin/env bash
set -euo pipefail

TARGET_ENV=production

deploy() {
  echo "deploying"
}

function rollback {
  echo "back"
}
`;

const KOTLIN = `package app

class Repository(private val db: Db) {
    fun findAll(): List<Item> = db.query()
    private fun cacheKey(): String = "k"
}

fun main() {
    println("hi")
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
    'cmd/main.go': GO,
    'src/lib.rs': RUST,
    'scripts/deploy.sh': SHELL,
    'app/Repository.kt': KOTLIN,
  });
});

afterAll(() => cleanup(root));

describe('Go', () => {
  const symbols = () => analyze('cmd/main.go').symbols;

  it('records types, functions, methods, and constants', () => {
    expect(symbols().map((s) => `${s.kind}:${s.name}`)).toEqual([
      'class:Server',
      'class:Handler',
      'method:Server.Start',
      'function:NewServer',
      'function:internalHelper',
      'const:DefaultPort',
    ]);
  });

  it('names a method after its receiver type', () => {
    expect(byName(symbols(), 'Server.Start').lang).toBe('go');
  });

  it('collects struct fields as members, and nothing from function bodies', () => {
    expect(byName(symbols(), 'Server').members).toEqual(['Addr', 'port']);
    expect(byName(symbols(), 'Server.Start').members).toBeUndefined();
  });

  it('follows the capitalization rule for visibility', () => {
    expect(byName(symbols(), 'NewServer').export).toBe('named');
    expect(byName(symbols(), 'internalHelper').export).toBe('none');
  });
});

describe('Rust', () => {
  const symbols = () => analyze('src/lib.rs').symbols;

  it('merges an impl block into the type it implements', () => {
    expect(byName(symbols(), 'Config').members).toEqual(['load', 'secret']);
  });

  it('reads visibility from pub', () => {
    expect(byName(symbols(), 'run').export).toBe('named');
    expect(byName(symbols(), 'helper').export).toBe('none');
  });
});

describe('shell and Kotlin', () => {
  it('finds both shell function forms and exported variables', () => {
    const symbols = analyze('scripts/deploy.sh').symbols;
    expect(symbols.map((s) => s.name)).toEqual(['TARGET_ENV', 'deploy', 'rollback']);
  });

  it('finds Kotlin classes with their functions, and top-level functions', () => {
    const symbols = analyze('app/Repository.kt').symbols;
    expect(symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'class:Repository',
      'function:main',
    ]);
    expect(byName(symbols, 'Repository').members).toEqual(['findAll', 'cacheKey']);
  });
});

describe('change detection', () => {
  it('hashes the whole declaration, so a body edit registers', () => {
    const before = byName(analyze('cmd/main.go').symbols, 'NewServer').bodyHash;
    writeFile(root, 'cmd/main.go', GO.replace('return &Server{Addr: addr}', 'return nil'));
    const after = byName(analyze('cmd/main.go').symbols, 'NewServer').bodyHash;
    expect(after).not.toBe(before);
    // an unrelated declaration keeps its hash
    expect(byName(analyze('cmd/main.go').symbols, 'DefaultPort').bodyHash).toBe(
      byName(analyze('cmd/main.go').symbols, 'DefaultPort').bodyHash
    );
    writeFile(root, 'cmd/main.go', GO);
  });

  it('shows up in a project scan', async () => {
    const analysis = await analyzeProject(root);
    const langs = new Set(analysis.symbols.map((s) => s.lang));
    expect([...langs].sort()).toEqual(['go', 'kotlin', 'rust', 'sh']);
  });
});
