import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { analyzeFile } from '../src/analyze';
import { edgesOf, FileAnalysis, SymbolInfo } from '../src/types';

const FIX = path.resolve('tests/fixtures/analyze');
const analyze = (name: string) => analyzeFile(path.join(FIX, name), name);
/** Components only — the extractor also records types, consts, and helpers. */
const components = (res: FileAnalysis) => res.symbols.filter((s) => s.kind === 'component');
const byName = (symbols: SymbolInfo[], name: string) => {
  const c = symbols.find((x) => x.name === name);
  if (!c) throw new Error(`symbol ${name} not found in [${symbols.map((x) => x.name)}]`);
  return c;
};
const renders = (s: SymbolInfo) => edgesOf(s, 'renders').map((e) => e.name);

describe('class components', () => {
  const res = analyze('class-comp.tsx');

  it('finds classes extending React.Component / PureComponent', () => {
    expect(components(res).map((c) => c.name).sort()).toEqual(['Hidden', 'UserCard']);
    expect(components(res).every((c) => c.role?.includes('class'))).toBe(true);
  });

  it('collects this.props accesses as props', () => {
    expect(byName(res.symbols, 'UserCard').members!.sort()).toEqual(['label', 'title']);
    expect(byName(res.symbols, 'Hidden').members ?? []).toEqual(['x']);
  });

  it('tracks exports, including `export default Identifier`', () => {
    expect(byName(res.symbols, 'UserCard').export).toBe('default');
    expect(byName(res.symbols, 'Hidden').export).toBe('none');
  });

  it('records rendered children', () => {
    expect(renders(byName(res.symbols, 'UserCard'))).toEqual(['Button']);
  });
});

describe('memo / forwardRef wrappers', () => {
  const res = analyze('wrapped.tsx');

  it('unwraps memo, forwardRef, and memo(forwardRef(...))', () => {
    expect(components(res).map((c) => c.name).sort()).toEqual(['Both', 'Fancy', 'WithRef']);
  });

  it('still extracts props from the inner function', () => {
    expect(byName(res.symbols, 'Fancy').members ?? []).toEqual(['a']);
    expect(byName(res.symbols, 'WithRef').members ?? []).toEqual(['b']);
    expect(byName(res.symbols, 'Both').members ?? []).toEqual([]);
  });

  it('marks them as named exports', () => {
    expect(components(res).every((c) => c.export === 'named')).toBe(true);
  });
});

describe('anonymous default export', () => {
  it('names the component after the file', () => {
    const res = analyze('anon-default.tsx');
    expect(components(res)).toHaveLength(1);
    expect(components(res)[0].name).toBe('Anondefault');
    expect(components(res)[0].export).toBe('default');
  });
});

describe('hooks', () => {
  const res = analyze('hooks.tsx');

  it('captures hook calls in source order with bound-variable details', () => {
    expect(byName(res.symbols, 'Dashboard').hooks).toEqual([
      { name: 'useReducer', detail: 'state' },
      { name: 'useRef', detail: 'box' },
      { name: 'useQuery', detail: 'data, error' },
      { name: 'useContext', detail: 'theme' },
      { name: 'useEffect' },
    ]);
  });

  it('does not treat createContext or plain helpers as components', () => {
    expect(components(res).map((c) => c.name)).toEqual(['Dashboard']);
  });
});

describe('props extraction', () => {
  const res = analyze('props.tsx');

  it('reads destructured params merged with the referenced interface', () => {
    expect(byName(res.symbols, 'Card').members ?? []).toEqual(['title', 'subtitle']);
  });

  it('resolves same-file type aliases on identifier params', () => {
    expect(byName(res.symbols, 'Box').members ?? []).toEqual(['width', 'height']);
  });

  it('handles rest elements and inline type literals', () => {
    expect(byName(res.symbols, 'Inline').members ?? []).toEqual(['x', '...rest', 'y']);
  });

  it('resolves same-file interfaces on identifier params', () => {
    expect(byName(res.symbols, 'FromInterface').members ?? []).toEqual(['title', 'subtitle']);
  });
});

describe('JSX member expressions', () => {
  it('records dotted element names like Ctx.Provider', () => {
    const res = analyze('member-jsx.tsx');
    expect(renders(byName(res.symbols, 'Provider'))).toEqual(['ThemeContext.Provider']);
    expect(res.imports).toContainEqual({
      local: 'ThemeContext',
      imported: 'ThemeContext',
      source: './ctx',
    });
  });
});

describe('plain JavaScript (.jsx)', () => {
  const res = analyze('plain.jsx');

  it('parses without the TypeScript plugin', () => {
    expect(res.parseError).toBeUndefined();
  });

  it('skips lowercase functions and non-function bindings', () => {
    expect(components(res).map((c) => c.name)).toEqual(['Legacy']);
  });

  it('yields no props for untyped identifier params', () => {
    expect(byName(res.symbols, 'Legacy').members ?? []).toEqual([]);
  });
});

describe('broken files', () => {
  it('flags a parse error instead of crashing', () => {
    const res = analyze('broken.tsx');
    expect(res.parseError).toBeTruthy();
  });
});
