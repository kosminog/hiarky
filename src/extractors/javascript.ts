import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { parse, ParseResult, ParserPlugin } from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import {
  Edge,
  FileAnalysis,
  HookUsage,
  ImportBinding,
  Lang,
  ReexportBinding,
  SymbolInfo,
  SymbolKind,
} from '../types';

const COMPONENT_NAME = /^[A-Z]/;
const HOOK_NAME = /^use[A-Z0-9]/;

export const JAVASCRIPT_GLOBS = ['**/*.{js,jsx,ts,tsx,mjs,cjs}'];

export function matchesJavascript(file: string): boolean {
  return ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(path.extname(file));
}

function langOf(file: string): Lang {
  const ext = path.extname(file);
  if (ext === '.tsx') return 'tsx';
  if (ext === '.ts') return 'ts';
  if (ext === '.jsx') return 'jsx';
  return 'js';
}

function parserPluginsFor(file: string): ParserPlugin[] {
  const ext = path.extname(file);
  if (ext === '.ts') return ['typescript', 'decorators-legacy'];
  if (ext === '.tsx') return ['typescript', 'jsx', 'decorators-legacy'];
  return ['jsx', 'decorators-legacy'];
}

/** Short content hash of a declaration's source text. */
function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** Does this subtree contain JSX anywhere? */
function containsJsx(p: NodePath): boolean {
  let found = false;
  p.traverse({
    JSXElement() {
      found = true;
    },
    JSXFragment() {
      found = true;
    },
  });
  return found;
}

function jsxElementName(node: t.JSXOpeningElement): string {
  const parts: string[] = [];
  let cur: t.JSXOpeningElement['name'] = node.name;
  while (t.isJSXMemberExpression(cur)) {
    parts.unshift(cur.property.name);
    cur = cur.object;
  }
  if (t.isJSXIdentifier(cur)) parts.unshift(cur.name);
  else if (t.isJSXNamespacedName(cur)) parts.unshift(`${cur.namespace.name}:${cur.name.name}`);
  return parts.join('.');
}

/** Dotted name of a call target, e.g. "createRouter" or "z.object". */
function calleeName(node: t.Expression | t.V8IntrinsicIdentifier): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node)) {
    const head = calleeName(node.object as t.Expression);
    if (!head) return null;
    if (t.isIdentifier(node.property)) return `${head}.${node.property.name}`;
    return head;
  }
  return null;
}

/** Collect prop names from a component function's first parameter. */
function propsFromParam(param: t.Node | undefined, typeMembers: Map<string, string[]>): string[] {
  if (!param) return [];
  const props = new Set<string>();

  const addFromTypeAnnotation = (ann: t.Node | null | undefined) => {
    if (!ann || !t.isTSTypeAnnotation(ann)) return;
    const ty = ann.typeAnnotation;
    if (t.isTSTypeLiteral(ty)) {
      for (const m of ty.members) {
        if (t.isTSPropertySignature(m) && t.isIdentifier(m.key)) props.add(m.key.name);
      }
    } else if (t.isTSTypeReference(ty) && t.isIdentifier(ty.typeName)) {
      for (const name of typeMembers.get(ty.typeName.name) ?? []) props.add(name);
    }
  };

  if (t.isObjectPattern(param)) {
    for (const prop of param.properties) {
      if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) props.add(prop.key.name);
      else if (t.isRestElement(prop) && t.isIdentifier(prop.argument))
        props.add(`...${prop.argument.name}`);
    }
    addFromTypeAnnotation(param.typeAnnotation);
  } else if (t.isIdentifier(param)) {
    addFromTypeAnnotation(param.typeAnnotation);
  }
  return [...props];
}

/** Every identifier a binding pattern introduces: `const { a, b: [c] } = x`. */
function patternNames(node: t.Node | null | undefined): string[] {
  const out: string[] = [];
  const walk = (n: t.Node | null | undefined) => {
    if (!n) return;
    if (t.isIdentifier(n)) out.push(n.name);
    else if (t.isObjectPattern(n)) {
      for (const prop of n.properties) {
        if (t.isObjectProperty(prop)) walk(prop.value);
        else if (t.isRestElement(prop)) walk(prop.argument);
      }
    } else if (t.isArrayPattern(n)) {
      for (const el of n.elements) walk(el);
    } else if (t.isRestElement(n)) walk(n.argument);
    else if (t.isAssignmentPattern(n)) walk(n.left);
  };
  walk(node);
  return out;
}

/** Names of members for interfaces / object type aliases declared in this file. */
function collectTypeMembers(ast: t.File): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const record = (name: string, members: Array<t.TSTypeElement>) => {
    const names: string[] = [];
    for (const m of members) {
      if ((t.isTSPropertySignature(m) || t.isTSMethodSignature(m)) && t.isIdentifier(m.key))
        names.push(m.key.name);
    }
    map.set(name, names);
  };
  traverse(ast, {
    TSInterfaceDeclaration(p) {
      record(p.node.id.name, p.node.body.body);
    },
    TSTypeAliasDeclaration(p) {
      if (t.isTSTypeLiteral(p.node.typeAnnotation))
        record(p.node.id.name, p.node.typeAnnotation.members);
    },
  });
  return map;
}

interface BodyFacts {
  hooks: HookUsage[];
  edges: Edge[];
}

/**
 * Walk a declaration body for the facts a reviewer cares about: which
 * components it renders, which project functions it calls, which hooks it uses.
 */
function scanBody(p: NodePath, knownCallees: (name: string) => boolean): BodyFacts {
  const hooks: HookUsage[] = [];
  const renders = new Map<string, Edge>();
  const calls = new Map<string, Edge>();

  const visitCall = (cp: NodePath<t.CallExpression>) => {
    const name = calleeName(cp.node.callee as t.Expression);
    if (!name) return;
    const last = name.split('.').pop()!;

    if (HOOK_NAME.test(last)) {
      let detail: string | undefined;
      const parent = cp.parentPath;
      if (parent && t.isVariableDeclarator(parent.node)) {
        const id = parent.node.id;
        if (t.isArrayPattern(id) && id.elements.length > 0 && t.isIdentifier(id.elements[0])) {
          detail = id.elements[0].name; // const [count, setCount] = useState(...)
        } else if (t.isIdentifier(id)) {
          detail = id.name; // const ref = useRef(...)
        } else if (t.isObjectPattern(id)) {
          detail = id.properties
            .filter((pr): pr is t.ObjectProperty => t.isObjectProperty(pr))
            .map((pr) => (t.isIdentifier(pr.key) ? pr.key.name : '?'))
            .join(', ');
        }
      }
      hooks.push({ name: last, ...(detail ? { detail } : {}) });
      return;
    }

    // Only calls that can resolve to something in the project or a tracked
    // import; anything else (local helpers, params, globals) is noise.
    if (knownCallees(name.split('.')[0]) && !calls.has(name)) {
      calls.set(name, { kind: 'calls', name });
    }
  };

  const visitJsx = (jp: NodePath<t.JSXOpeningElement>) => {
    const name = jsxElementName(jp.node);
    if (COMPONENT_NAME.test(name) && !renders.has(name)) {
      renders.set(name, { kind: 'renders', name });
    }
  };

  p.traverse({
    CallExpression: visitCall,
    JSXOpeningElement: visitJsx,
  });

  return { hooks, edges: [...renders.values(), ...calls.values()] };
}

/** Normalized `(params): Return` text for a function-ish node. */
function signatureOf(fn: t.Function, source: string): string | undefined {
  const slice = (n: t.Node) =>
    n.start != null && n.end != null ? source.slice(n.start, n.end) : '';
  const params = fn.params.map(slice).join(', ');
  const ret =
    'returnType' in fn && fn.returnType && t.isTSTypeAnnotation(fn.returnType)
      ? ': ' + slice(fn.returnType.typeAnnotation)
      : '';
  return `(${params})${ret}`.replace(/\s+/g, ' ').trim();
}

/** Unwrap memo(...) / forwardRef(...) / memo(forwardRef(...)) to the inner function. */
function unwrapHoc(node: t.Node): t.Node {
  let cur = node;
  while (
    t.isCallExpression(cur) &&
    cur.arguments.length > 0 &&
    (t.isIdentifier(cur.callee) || t.isMemberExpression(cur.callee))
  ) {
    const name = t.isIdentifier(cur.callee)
      ? cur.callee.name
      : t.isIdentifier(cur.callee.property)
        ? cur.callee.property.name
        : '';
    if (!['memo', 'forwardRef'].includes(name)) break;
    cur = cur.arguments[0] as t.Node;
  }
  return cur;
}

/** Find the NodePath of a node already known to live under `parent`. */
function pathOf(parent: NodePath, node: t.Node): NodePath | null {
  let found: NodePath | null = null;
  parent.traverse({
    enter(p) {
      if (p.node === node) {
        found = p;
        p.stop();
      }
    },
  });
  return found;
}

/**
 * Analyze one JS/TS file into symbols, imports, and re-exports.
 *
 * Every module-scope declaration becomes a symbol — React components are the
 * `component` kind, not the only thing recorded, so changes to server code,
 * types, and constants show up in a review summary too.
 */
export function analyzeJavascript(absFile: string, relFile: string): FileAnalysis {
  const source = fs.readFileSync(absFile, 'utf8');
  const lang = langOf(relFile);
  let ast: ParseResult<t.File>;
  let parseError: string | undefined;
  try {
    ast = parse(source, {
      sourceType: 'unambiguous',
      plugins: parserPluginsFor(absFile),
      errorRecovery: true,
    });
    // errorRecovery collects most syntax errors instead of throwing; record the
    // first one so broken files are flagged while still analyzing what parsed.
    if (ast.errors && ast.errors.length > 0) {
      parseError = String((ast.errors[0] as { message?: string }).message ?? ast.errors[0]);
    }
  } catch (err) {
    return {
      file: relFile,
      symbols: [],
      imports: [],
      reexports: [],
      parseError: err instanceof Error ? err.message : String(err),
    };
  }

  const imports: ImportBinding[] = [];
  const reexports: ReexportBinding[] = [];
  const typeMembers = collectTypeMembers(ast);
  const exportedNames = new Set<string>();
  let defaultExportName: string | null = null;

  // Roles from file-level directives ("use client" / "use server")
  const role: string[] = [];
  for (const d of ast.program.directives) {
    if (d.value.value === 'use client') role.push('client');
    if (d.value.value === 'use server') role.push('server');
  }

  // Pass 1: imports, re-exports, and export markers
  traverse(ast, {
    ImportDeclaration(p) {
      for (const spec of p.node.specifiers) {
        if (t.isImportSpecifier(spec)) {
          imports.push({
            local: spec.local.name,
            imported: t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value,
            source: p.node.source.value,
          });
        } else if (t.isImportDefaultSpecifier(spec)) {
          imports.push({
            local: spec.local.name,
            imported: 'default',
            source: p.node.source.value,
          });
        } else if (t.isImportNamespaceSpecifier(spec)) {
          imports.push({ local: spec.local.name, imported: '*', source: p.node.source.value });
        }
      }
    },
    ExportAllDeclaration(p) {
      reexports.push({ exported: '*', imported: '*', source: p.node.source.value });
    },
    ExportNamedDeclaration(p) {
      const decl = p.node.declaration;
      if (t.isFunctionDeclaration(decl) && decl.id) exportedNames.add(decl.id.name);
      if (t.isClassDeclaration(decl) && decl.id) exportedNames.add(decl.id.name);
      if (t.isTSInterfaceDeclaration(decl) || t.isTSTypeAliasDeclaration(decl))
        exportedNames.add(decl.id.name);
      if (t.isTSEnumDeclaration(decl)) exportedNames.add(decl.id.name);
      if (t.isVariableDeclaration(decl)) {
        for (const d of decl.declarations) {
          for (const n of patternNames(d.id)) exportedNames.add(n);
        }
      }
      for (const spec of p.node.specifiers) {
        if (!t.isExportSpecifier(spec)) continue;
        const exported = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
        if (p.node.source) {
          reexports.push({ exported, imported: spec.local.name, source: p.node.source.value });
        } else {
          exportedNames.add(spec.local.name);
        }
      }
    },
    ExportDefaultDeclaration(p) {
      const decl = p.node.declaration;
      if (t.isIdentifier(decl)) defaultExportName = decl.name;
      else if ((t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) && decl.id)
        defaultExportName = decl.id.name;
    },
  });

  const importLocals = new Set(imports.map((i) => i.local));
  const topLevelNames = new Set<string>();

  // Top-level statement paths, so nested helpers never become symbols
  let bodyPaths: NodePath[] = [];
  traverse(ast, {
    Program(p) {
      bodyPaths = p.get('body') as NodePath[];
      p.stop();
    },
  });

  // Pre-pass: names declared at module scope (used to filter `calls` edges)
  for (const stmt of bodyPaths) {
    const node = stmt.isExportNamedDeclaration() || stmt.isExportDefaultDeclaration()
      ? stmt.node.declaration
      : stmt.node;
    if (!node) continue;
    if ((t.isFunctionDeclaration(node) || t.isClassDeclaration(node)) && node.id)
      topLevelNames.add(node.id.name);
    if (t.isVariableDeclaration(node)) {
      for (const d of node.declarations) {
        for (const n of patternNames(d.id)) topLevelNames.add(n);
      }
    }
  }
  const knownCallee = (name: string) => importLocals.has(name) || topLevelNames.has(name);

  const symbols: SymbolInfo[] = [];
  const seen = new Set<string>();
  const fallbackName = () => {
    const base = path.basename(absFile).replace(/\.[^.]+$/, '');
    const cleaned = base === 'index' ? path.basename(path.dirname(absFile)) : base;
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).replace(/[^A-Za-z0-9]/g, '');
  };
  const srcOf = (node: t.Node) =>
    node.start != null && node.end != null ? source.slice(node.start, node.end) : '';

  const push = (
    name: string,
    kind: SymbolKind,
    node: t.Node,
    extra: Partial<SymbolInfo> = {}
  ) => {
    if (seen.has(name)) return;
    seen.add(name);
    const exported: SymbolInfo['export'] =
      defaultExportName === name ? 'default' : exportedNames.has(name) ? 'named' : 'none';
    const sym: SymbolInfo = {
      id: `${relFile}#${name}`,
      name,
      file: relFile,
      lang,
      kind,
      export: exported,
      edges: [],
      bodyHash: hashOf(srcOf(node)),
      ...(role.length ? { role: [...role] } : {}),
      ...extra,
    };
    if (sym.members && sym.members.length === 0) delete sym.members;
    if (sym.hooks && sym.hooks.length === 0) delete sym.hooks;
    symbols.push(sym);
  };

  /** A function-shaped declaration: component when capitalized and rendering JSX. */
  const addFunction = (name: string, fnNode: t.Function, fnPath: NodePath, declNode: t.Node) => {
    const isComponent = COMPONENT_NAME.test(name) && containsJsx(fnPath);
    const { hooks, edges } = scanBody(fnPath, knownCallee);
    push(name, isComponent ? 'component' : 'function', declNode, {
      signature: signatureOf(fnNode, source),
      ...(isComponent ? { members: propsFromParam(fnNode.params[0], typeMembers) } : {}),
      hooks,
      edges,
    });
  };

  const addClass = (name: string, node: t.ClassDeclaration, p: NodePath, declNode: t.Node) => {
    const sc = node.superClass;
    const superName = sc ? calleeName(sc as t.Expression) : null;
    const isReactClass =
      !!superName && ['Component', 'PureComponent'].includes(superName.split('.').pop()!);

    const members: string[] = [];
    for (const m of node.body.body) {
      if ((t.isClassMethod(m) || t.isClassProperty(m)) && t.isIdentifier(m.key)) {
        if (m.key.name !== 'constructor') members.push(m.key.name);
      }
    }

    const props = new Set<string>();
    p.traverse({
      MemberExpression(mp) {
        // this.props.x
        if (
          t.isMemberExpression(mp.node.object) &&
          t.isThisExpression(mp.node.object.object) &&
          t.isIdentifier(mp.node.object.property, { name: 'props' }) &&
          t.isIdentifier(mp.node.property)
        ) {
          props.add(mp.node.property.name);
        }
      },
    });

    // Methods render and call like any other body
    const { hooks, edges } = scanBody(p, knownCallee);
    if (superName && knownCallee(superName.split('.')[0])) {
      edges.push({ kind: 'extends', name: superName });
    }
    push(name, isReactClass ? 'component' : 'class', declNode, {
      // A class component is still a component; the class shape is a role tag
      // so `kind` stays the thing a reviewer filters on.
      ...(isReactClass ? { role: [...role, 'class'] } : {}),
      members: isReactClass ? [...props] : members,
      hooks,
      edges,
    });
  };

  for (const stmt of bodyPaths) {
    const isExportWrapper = stmt.isExportNamedDeclaration() || stmt.isExportDefaultDeclaration();
    const declPath = (isExportWrapper ? stmt.get('declaration') : stmt) as NodePath;
    const node = declPath?.node;
    if (!node || Array.isArray(declPath)) continue;

    if (t.isFunctionDeclaration(node)) {
      if (node.id) addFunction(node.id.name, node, declPath, node);
      else if (stmt.isExportDefaultDeclaration()) {
        // export default function () { ... }
        const name = fallbackName();
        defaultExportName = name;
        addFunction(name, node, declPath, node);
      }
      continue;
    }

    if (t.isClassDeclaration(node)) {
      if (node.id) addClass(node.id.name, node, declPath, node);
      continue;
    }

    if (t.isTSInterfaceDeclaration(node)) {
      push(node.id.name, 'type', node, { members: typeMembers.get(node.id.name) ?? [] });
      continue;
    }

    if (t.isTSTypeAliasDeclaration(node)) {
      push(node.id.name, 'type', node, { members: typeMembers.get(node.id.name) ?? [] });
      continue;
    }

    if (t.isTSEnumDeclaration(node)) {
      push(node.id.name, 'type', node, {
        members: node.members
          .map((m) => (t.isIdentifier(m.id) ? m.id.name : m.id.value))
          .filter((n): n is string => typeof n === 'string'),
      });
      continue;
    }

    if (t.isVariableDeclaration(node)) {
      for (const d of node.declarations) {
        if (!d.init) continue;
        if (!t.isIdentifier(d.id)) {
          // `export const { trpc: api, HydrateClient } = createHelpers(...)`:
          // one symbol per bound name, all describing the same initializer.
          const declaratorPath = pathOf(declPath, d) ?? declPath;
          const { hooks, edges } = scanBody(declaratorPath, knownCallee);
          for (const bound of patternNames(d.id)) {
            push(bound, 'const', d, { hooks, edges: [...edges] });
          }
          continue;
        }
        const name = d.id.name;
        const inner = unwrapHoc(d.init);
        if (t.isArrowFunctionExpression(inner) || t.isFunctionExpression(inner)) {
          const fnPath = pathOf(declPath, inner);
          if (fnPath) addFunction(name, inner, fnPath, d);
          continue;
        }
        const declaratorPath = pathOf(declPath, d) ?? declPath;
        const { hooks, edges } = scanBody(declaratorPath, knownCallee);
        const members = t.isObjectExpression(inner)
          ? inner.properties
              .map((pr) =>
                (t.isObjectProperty(pr) || t.isObjectMethod(pr)) && t.isIdentifier(pr.key)
                  ? pr.key.name
                  : null
              )
              .filter((n): n is string => n !== null)
          : [];
        push(name, 'const', d, { members, hooks, edges });
      }
      continue;
    }

    // export default <expression> — anonymous components and HOC wrappers
    if (stmt.isExportDefaultDeclaration() && t.isExpression(node)) {
      const inner = unwrapHoc(node);
      if (t.isArrowFunctionExpression(inner) || t.isFunctionExpression(inner)) {
        const fnPath = pathOf(stmt, inner);
        if (fnPath) {
          const name = fallbackName();
          defaultExportName = name;
          addFunction(name, inner, fnPath, node);
        }
      }
    }
  }

  return {
    file: relFile,
    symbols,
    imports,
    reexports,
    ...(parseError ? { parseError } : {}),
  };
}
