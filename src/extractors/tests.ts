import * as path from 'path';
import * as t from '@babel/types';

/**
 * Test files are source too. A review that cannot say "this procedure changed
 * and no test that exercises it changed" is missing the question reviewers
 * most often have to ask by hand.
 */

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIR_SEGMENTS = new Set(['__tests__', '__mocks__']);

const SUITE_CALLS = new Set(['describe', 'suite', 'context']);
const CASE_CALLS = new Set(['it', 'test', 'bench']);

/**
 * The test runner's own API. Every suite calls these, so they say nothing
 * about what the suite exercises and would drown the real edges.
 */
const HARNESS = new Set([
  'describe',
  'suite',
  'context',
  'it',
  'test',
  'bench',
  'expect',
  'assert',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  'vi',
  'vitest',
  'jest',
  'chai',
  'sinon',
]);

/** Is this call part of the test framework rather than the code under test? */
export function isHarnessCall(name: string): boolean {
  return HARNESS.has(name.split('.')[0]);
}

export function isTestFile(relFile: string): boolean {
  if (TEST_FILE.test(path.basename(relFile))) return true;
  return relFile.split('/').some((segment) => TEST_DIR_SEGMENTS.has(segment));
}

/** `describe`, `describe.skip`, `it.each(…)` — the head identifier is the name. */
function callHead(node: t.Expression | t.V8IntrinsicIdentifier): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node)) return callHead(node.object as t.Expression);
  if (t.isCallExpression(node)) return callHead(node.callee);
  return null;
}

function titleOf(node: t.Node | undefined): string | null {
  if (!node) return null;
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node)) {
    // `renders ${kind} rows` — keep the static skeleton so renames still match
    return node.quasis.map((q) => q.value.cooked ?? '').join('${}').trim() || null;
  }
  return null;
}

/** The callback body of a describe/it call, where nested cases live. */
function callbackOf(call: t.CallExpression): t.Node | null {
  for (const arg of call.arguments) {
    if (t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg)) return arg.body;
  }
  return null;
}

export interface TestSuite {
  /** Suite title, or the file's base name for cases declared at top level */
  title: string;
  /** Case names, nested ones joined as "outer > inner" */
  cases: string[];
  /** The node to hash and scan for edges */
  node: t.Node;
}

function collectCases(body: t.Node | null, prefix: string, out: string[]): void {
  if (!body) return;
  const statements = t.isBlockStatement(body) ? body.body : [];
  for (const statement of statements) {
    if (!t.isExpressionStatement(statement) || !t.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    const head = callHead(call.callee);
    if (!head) continue;
    const title = titleOf(call.arguments[0]);
    if (!title) continue;

    if (CASE_CALLS.has(head)) {
      out.push(prefix ? `${prefix} > ${title}` : title);
    } else if (SUITE_CALLS.has(head)) {
      collectCases(callbackOf(call), prefix ? `${prefix} > ${title}` : title, out);
    }
  }
}

/**
 * Top-level suites in a test file. Cases declared outside any suite are
 * gathered into one entry named after the file.
 */
export function testSuitesOf(program: t.Program, relFile: string): TestSuite[] {
  const suites: TestSuite[] = [];
  const looseCases: string[] = [];
  let looseNode: t.Node | null = null;

  for (const statement of program.body) {
    if (!t.isExpressionStatement(statement) || !t.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    const head = callHead(call.callee);
    if (!head) continue;
    const title = titleOf(call.arguments[0]);
    if (!title) continue;

    if (SUITE_CALLS.has(head)) {
      const cases: string[] = [];
      collectCases(callbackOf(call), '', cases);
      suites.push({ title, cases, node: call });
    } else if (CASE_CALLS.has(head)) {
      looseCases.push(title);
      looseNode ??= call;
    }
  }

  if (looseCases.length && looseNode) {
    suites.push({
      title: path.basename(relFile).replace(/\.[^.]+$/, ''),
      cases: looseCases,
      node: looseNode,
    });
  }
  return suites;
}
