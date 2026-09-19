import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { analyzeFile } from '../src/analyze';
import { ComponentInfo } from '../src/types';

const FIX = path.resolve('tests/fixtures/analyze');
const analyze = (name: string) => analyzeFile(path.join(FIX, name), name);
const byName = (components: ComponentInfo[], name: string) => {
  const c = components.find((x) => x.name === name);
  if (!c) throw new Error(`component ${name} not found in [${components.map((x) => x.name)}]`);
  return c;
};

describe('class components', () => {
  const res = analyze('class-comp.tsx');

  it('finds classes extending React.Component / PureComponent', () => {
    expect(res.components.map((c) => c.name).sort()).toEqual(['Hidden', 'UserCard']);
    expect(res.components.every((c) => c.kind === 'class')).toBe(true);
  });

  it('collects this.props accesses as props', () => {
    expect(byName(res.components, 'UserCard').props.sort()).toEqual(['label', 'title']);
    expect(byName(res.components, 'Hidden').props).toEqual(['x']);
  });

  it('tracks exports, including `export default Identifier`', () => {
    expect(byName(res.components, 'UserCard').export).toBe('default');
    expect(byName(res.components, 'Hidden').export).toBe('none');
  });

  it('records rendered children', () => {
    expect(byName(res.components, 'UserCard').renders.map((r) => r.name)).toEqual(['Button']);
  });
});

describe('memo / forwardRef wrappers', () => {
  const res = analyze('wrapped.tsx');

  it('unwraps memo, forwardRef, and memo(forwardRef(...))', () => {
    expect(res.components.map((c) => c.name).sort()).toEqual(['Both', 'Fancy', 'WithRef']);
  });

  it('still extracts props from the inner function', () => {
    expect(byName(res.components, 'Fancy').props).toEqual(['a']);
    expect(byName(res.components, 'WithRef').props).toEqual(['b']);
    expect(byName(res.components, 'Both').props).toEqual([]);
  });

  it('marks them as named exports', () => {
    expect(res.components.every((c) => c.export === 'named')).toBe(true);
  });
});

describe('anonymous default export', () => {
  it('names the component after the file', () => {
    const res = analyze('anon-default.tsx');
    expect(res.components).toHaveLength(1);
    expect(res.components[0].name).toBe('Anondefault');
    expect(res.components[0].export).toBe('default');
  });
});

describe('hooks', () => {
  const res = analyze('hooks.tsx');

  it('captures hook calls in source order with bound-variable details', () => {
    expect(byName(res.components, 'Dashboard').hooks).toEqual([
      { name: 'useReducer', detail: 'state' },
      { name: 'useRef', detail: 'box' },
      { name: 'useQuery', detail: 'data, error' },
      { name: 'useContext', detail: 'theme' },
      { name: 'useEffect' },
    ]);
  });

  it('does not treat createContext or plain helpers as components', () => {
    expect(res.components.map((c) => c.name)).toEqual(['Dashboard']);
  });
});

describe('props extraction', () => {
  const res = analyze('props.tsx');

  it('reads destructured params merged with the referenced interface', () => {
    expect(byName(res.components, 'Card').props).toEqual(['title', 'subtitle']);
  });

  it('resolves same-file type aliases on identifier params', () => {
    expect(byName(res.components, 'Box').props).toEqual(['width', 'height']);
  });

  it('handles rest elements and inline type literals', () => {
    expect(byName(res.components, 'Inline').props).toEqual(['x', '...rest', 'y']);
  });

  it('resolves same-file interfaces on identifier params', () => {
    expect(byName(res.components, 'FromInterface').props).toEqual(['title', 'subtitle']);
  });
});

describe('JSX member expressions', () => {
  it('records dotted element names like Ctx.Provider', () => {
    const res = analyze('member-jsx.tsx');
    expect(byName(res.components, 'Provider').renders.map((r) => r.name)).toEqual([
      'ThemeContext.Provider',
    ]);
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
    expect(res.components.map((c) => c.name)).toEqual(['Legacy']);
  });

  it('yields no props for untyped identifier params', () => {
    expect(byName(res.components, 'Legacy').props).toEqual([]);
  });
});

describe('broken files', () => {
  it('flags a parse error instead of crashing', () => {
    const res = analyze('broken.tsx');
    expect(res.parseError).toBeTruthy();
  });
});
