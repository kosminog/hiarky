import * as fs from 'fs';
import * as path from 'path';
import { parse, ParserPlugin } from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import {
  ComponentInfo,
  FileAnalysis,
  HookUsage,
  ImportBinding,
  RenderedChild,
} from './types';

const COMPONENT_NAME = /^[A-Z]/;
const HOOK_NAME = /^use[A-Z0-9]/;

function parserPluginsFor(file: string): ParserPlugin[] {
  const ext = path.extname(file);
  if (ext === '.ts') return ['typescript', 'decorators-legacy'];
  if (ext === '.tsx') return ['typescript', 'jsx', 'decorators-legacy'];
  return ['jsx', 'decorators-legacy'];
}

/** Does this function body contain JSX anywhere? */
function containsJsx(fnPath: NodePath): boolean {
  let found = false;
  fnPath.traverse({
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

/** Collect prop names from a component function's first parameter. */
function propsFromParam(
  param: t.Node | undefined,
  typeMembers: Map<string, string[]>
): string[] {
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

/** Names of members for interfaces / object type aliases declared in this file. */
function collectTypeMembers(ast: t.File): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const record = (name: string, members: Array<t.TSTypeElement>) => {
    const names: string[] = [];
    for (const m of members) {
      if (t.isTSPropertySignature(m) && t.isIdentifier(m.key)) names.push(m.key.name);
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

interface FnCandidate {
  name: string;
  fnPath: NodePath<t.Function>;
  exported: 'default' | 'named' | 'none';
}

/**
 * Analyze one source file: find React components, their props, hooks,
 * and the components they render, plus the file's import bindings.
 */
export function analyzeFile(absFile: string, relFile: string): FileAnalysis {
  const source = fs.readFileSync(absFile, 'utf8');
  let ast: t.File;
  try {
    ast = parse(source, {
      sourceType: 'unambiguous',
      plugins: parserPluginsFor(absFile),
      errorRecovery: true,
    });
  } catch (err) {
    return {
      file: relFile,
      components: [],
      imports: [],
      parseError: err instanceof Error ? err.message : String(err),
    };
  }

  const imports: ImportBinding[] = [];
  const typeMembers = collectTypeMembers(ast);
  const candidates: FnCandidate[] = [];
  const classComponents: ComponentInfo[] = [];
  const exportedNames = new Set<string>();
  let defaultExportName: string | null = null;

  // Pass 1: imports and export markers
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
          imports.push({ local: spec.local.name, imported: 'default', source: p.node.source.value });
        } else if (t.isImportNamespaceSpecifier(spec)) {
          imports.push({ local: spec.local.name, imported: '*', source: p.node.source.value });
        }
      }
    },
    ExportNamedDeclaration(p) {
      const decl = p.node.declaration;
      if (t.isFunctionDeclaration(decl) && decl.id) exportedNames.add(decl.id.name);
      if (t.isClassDeclaration(decl) && decl.id) exportedNames.add(decl.id.name);
      if (t.isVariableDeclaration(decl)) {
        for (const d of decl.declarations) {
          if (t.isIdentifier(d.id)) exportedNames.add(d.id.name);
        }
      }
      for (const spec of p.node.specifiers) {
        if (t.isExportSpecifier(spec)) exportedNames.add(spec.local.name);
      }
    },
    ExportDefaultDeclaration(p) {
      const decl = p.node.declaration;
      if (t.isIdentifier(decl)) defaultExportName = decl.name;
      else if ((t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) && decl.id)
        defaultExportName = decl.id.name;
    },
  });

  const fallbackName = () => {
    const base = path.basename(absFile).replace(/\.[^.]+$/, '');
    const cleaned = base === 'index' ? path.basename(path.dirname(absFile)) : base;
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).replace(/[^A-Za-z0-9]/g, '');
  };

  /** Unwrap memo(...) / forwardRef(...) / memo(forwardRef(...)) to the inner function. */
  const unwrapHoc = (node: t.Node): t.Node => {
    let cur = node;
    while (
      t.isCallExpression(cur) &&
      cur.arguments.length > 0 &&
      (t.isIdentifier(cur.callee) || t.isMemberExpression(cur.callee))
    ) {
      const calleeName = t.isIdentifier(cur.callee)
        ? cur.callee.name
        : t.isIdentifier(cur.callee.property)
          ? cur.callee.property.name
          : '';
      if (!['memo', 'forwardRef'].includes(calleeName)) break;
      cur = cur.arguments[0] as t.Node;
    }
    return cur;
  };

  // Pass 2: component candidates
  traverse(ast, {
    FunctionDeclaration(p) {
      const name = p.node.id?.name;
      if (name && COMPONENT_NAME.test(name) && containsJsx(p)) {
        candidates.push({
          name,
          fnPath: p as NodePath<t.Function>,
          exported:
            defaultExportName === name ? 'default' : exportedNames.has(name) ? 'named' : 'none',
        });
      }
    },
    VariableDeclarator(p) {
      if (!t.isIdentifier(p.node.id)) return;
      const name = p.node.id.name;
      if (!COMPONENT_NAME.test(name) || !p.node.init) return;
      const inner = unwrapHoc(p.node.init);
      if (!t.isArrowFunctionExpression(inner) && !t.isFunctionExpression(inner)) return;
      // Locate the NodePath of the inner function
      let fnPath: NodePath<t.Function> | null = null;
      p.traverse({
        'ArrowFunctionExpression|FunctionExpression'(fp) {
          if (fp.node === inner) {
            fnPath = fp as NodePath<t.Function>;
            fp.stop();
          }
        },
      });
      if (fnPath && containsJsx(fnPath)) {
        candidates.push({
          name,
          fnPath,
          exported:
            defaultExportName === name ? 'default' : exportedNames.has(name) ? 'named' : 'none',
        });
      }
    },
    ExportDefaultDeclaration(p) {
      // export default function () { ... }  (anonymous)
      const decl = p.node.declaration;
      const inner = unwrapHoc(decl);
      if (
        (t.isArrowFunctionExpression(inner) || t.isFunctionExpression(inner) ||
          (t.isFunctionDeclaration(inner) && !inner.id))
      ) {
        let fnPath: NodePath<t.Function> | null = null;
        p.traverse({
          'ArrowFunctionExpression|FunctionExpression|FunctionDeclaration'(fp) {
            if (fp.node === inner) {
              fnPath = fp as NodePath<t.Function>;
              fp.stop();
            }
          },
        });
        if (fnPath && containsJsx(fnPath)) {
          const name = fallbackName();
          defaultExportName = name;
          candidates.push({ name, fnPath, exported: 'default' });
        }
      }
    },
    ClassDeclaration(p) {
      const name = p.node.id?.name;
      if (!name || !COMPONENT_NAME.test(name)) return;
      const sc = p.node.superClass;
      const isReactClass =
        (t.isIdentifier(sc) && ['Component', 'PureComponent'].includes(sc.name)) ||
        (t.isMemberExpression(sc) &&
          t.isIdentifier(sc.property) &&
          ['Component', 'PureComponent'].includes(sc.property.name));
      if (!isReactClass) return;

      const props = new Set<string>();
      const renders = new Map<string, RenderedChild>();
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
        JSXOpeningElement(jp) {
          const jname = jsxElementName(jp.node);
          if (COMPONENT_NAME.test(jname)) renders.set(jname, { name: jname });
        },
      });
      classComponents.push({
        id: `${relFile}#${name}`,
        name,
        file: relFile,
        kind: 'class',
        export:
          defaultExportName === name ? 'default' : exportedNames.has(name) ? 'named' : 'none',
        props: [...props],
        hooks: [],
        renders: [...renders.values()],
      });
    },
  });

  const components: ComponentInfo[] = [...classComponents];
  const seen = new Set(classComponents.map((c) => c.name));

  for (const cand of candidates) {
    if (seen.has(cand.name)) continue;
    seen.add(cand.name);

    const hooks: HookUsage[] = [];
    const renders = new Map<string, RenderedChild>();
    const fn = cand.fnPath;

    fn.traverse({
      CallExpression(cp) {
        // Skip hook calls inside nested component definitions? For MVP,
        // nested capitalized functions are rare; attribute to the outer component.
        let hookName: string | null = null;
        if (t.isIdentifier(cp.node.callee) && HOOK_NAME.test(cp.node.callee.name)) {
          hookName = cp.node.callee.name;
        } else if (
          t.isMemberExpression(cp.node.callee) &&
          t.isIdentifier(cp.node.callee.property) &&
          HOOK_NAME.test(cp.node.callee.property.name)
        ) {
          hookName = cp.node.callee.property.name;
        }
        if (!hookName) return;

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
        hooks.push({ name: hookName, ...(detail ? { detail } : {}) });
      },
      JSXOpeningElement(jp) {
        const jname = jsxElementName(jp.node);
        if (COMPONENT_NAME.test(jname)) renders.set(jname, { name: jname });
      },
    });

    components.push({
      id: `${relFile}#${cand.name}`,
      name: cand.name,
      file: relFile,
      kind: 'function',
      export: cand.exported,
      props: propsFromParam(fn.node.params[0], typeMembers),
      hooks,
      renders: [...renders.values()],
    });
  }

  return { file: relFile, components, imports };
}
