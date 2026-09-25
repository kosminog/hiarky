import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { analyzeFile } from '../src/analyze';
import { contentHashOf } from '../src/snap';
import { edgesOf, SymbolInfo } from '../src/types';
import { cleanup, makeProject, makeSymbol, writeFile } from './helpers';

const FIX = path.resolve('tests/fixtures/analyze');
const analyze = (name: string) => analyzeFile(path.join(FIX, name), name);
const byName = (symbols: SymbolInfo[], name: string) => {
  const s = symbols.find((x) => x.name === name);
  if (!s) throw new Error(`symbol ${name} not found in [${symbols.map((x) => x.name)}]`);
  return s;
};

describe('non-component symbols', () => {
  const res = analyze('module.ts');

  it('records every module-scope declaration, not just components', () => {
    expect(res.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'type:Options',
      'type:Mode',
      'type:Level',
      'const:LIMITS',
      'const:schema',
      'function:run',
      'class:Service',
      'function:privateHelper',
    ]);
  });

  it('ignores functions nested inside a declaration', () => {
    expect(res.symbols.map((s) => s.name)).not.toContain('inner');
  });

  it('captures interface and enum members', () => {
    expect(byName(res.symbols, 'Options').members).toEqual(['retries', 'timeout']);
    expect(byName(res.symbols, 'Level').members).toEqual(['Low', 'High']);
  });

  it('captures object-literal keys as const members', () => {
    expect(byName(res.symbols, 'LIMITS').members).toEqual(['max', 'min']);
  });

  it('captures class members', () => {
    expect(byName(res.symbols, 'Service').members).toEqual(['url', 'start']);
  });

  it('records normalized function signatures', () => {
    expect(byName(res.symbols, 'run').signature).toBe(
      '(input: string, opts: Options): Promise<void>'
    );
  });

  it('records calls to imports and to project functions', () => {
    expect(edgesOf(byName(res.symbols, 'run'), 'calls').map((e) => e.name)).toEqual(['helper']);
    expect(edgesOf(byName(res.symbols, 'schema'), 'calls').map((e) => e.name)).toEqual([
      'z.object',
      'z.string',
    ]);
    expect(edgesOf(byName(res.symbols, 'Service'), 'calls').map((e) => e.name)).toEqual(['run']);
  });

  it('tracks export status per symbol', () => {
    expect(byName(res.symbols, 'run').export).toBe('named');
    expect(byName(res.symbols, 'privateHelper').export).toBe('none');
  });

  it('records the line each declaration starts on', () => {
    expect(byName(res.symbols, 'Options').line).toBe(4);
    expect(byName(res.symbols, 'run').line).toBe(20);
    expect(byName(res.symbols, 'privateHelper').line).toBe(32);
  });

  it('records the language of each symbol', () => {
    expect(res.symbols.every((s) => s.lang === 'ts')).toBe(true);
  });
});

describe('roles', () => {
  it('tags symbols in a "use client" file', () => {
    const widget = byName(analyze('client-comp.tsx').symbols, 'Widget');
    expect(widget.role).toEqual(['client']);
    expect(widget.kind).toBe('component');
  });
});

describe('contentHash', () => {
  it('ignores where a declaration sits, so shifted code is not a new snapshot', () => {
    const at = (line: number) => [makeSymbol({ id: 'src/a.ts#f', bodyHash: 'same', line })];
    expect(contentHashOf(at(3), [])).toBe(contentHashOf(at(9), []));
    expect(contentHashOf(at(3), [])).not.toBe(
      contentHashOf([makeSymbol({ id: 'src/a.ts#f', bodyHash: 'other', line: 3 })], [])
    );
  });
});

describe('bodyHash', () => {
  const hashOf = (root: string, source: string) => {
    writeFile(root, 'src/f.ts', source);
    return byName(analyzeFile(path.join(root, 'src/f.ts'), 'src/f.ts').symbols, 'f').bodyHash;
  };

  it('is stable for identical source and changes with the body', () => {
    const root = makeProject();
    try {
      const a = hashOf(root, 'export function f() {\n  return 1;\n}\n');
      const same = hashOf(root, 'export function f() {\n  return 1;\n}\n');
      const changed = hashOf(root, 'export function f() {\n  return 2;\n}\n');
      expect(a).toBe(same);
      expect(a).not.toBe(changed);
      expect(a).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      cleanup(root);
    }
  });

  it('is unaffected by edits elsewhere in the file', () => {
    const root = makeProject();
    try {
      const before = hashOf(root, 'export function f() {\n  return 1;\n}\nexport const x = 1;\n');
      const after = hashOf(root, 'export function f() {\n  return 1;\n}\nexport const x = 2;\n');
      expect(before).toBe(after);
    } finally {
      cleanup(root);
    }
  });
});
