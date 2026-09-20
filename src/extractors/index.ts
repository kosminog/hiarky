import { FileAnalysis } from '../types';
import { analyzeConfig, CONFIG_GLOBS, matchesConfig } from './config';
import { analyzeGeneric, GENERIC_GLOBS, matchesGeneric } from './generic';
import { analyzeJavascript, JAVASCRIPT_GLOBS, matchesJavascript } from './javascript';
import { analyzePrisma, matchesPrisma, PRISMA_GLOBS } from './prisma';
import { analyzePython, analyzePythonMany, matchesPython, PYTHON_GLOBS } from './python';
import { analyzeSql, matchesSql, SQL_GLOBS } from './sql';

/**
 * A language (or file-format) plugin. Everything downstream — linking,
 * snapshotting, diffing, the viewer — works on the FileAnalysis an extractor
 * returns, so adding Python or a schema parser means adding one of these and
 * nothing else.
 */
export interface Extractor {
  name: string;
  /** Glob patterns this extractor claims, relative to the project root */
  globs: string[];
  /** Does this extractor handle the given file path? */
  matches(file: string): boolean;
  analyze(absFile: string, relFile: string): FileAnalysis;
  /**
   * Optional batch entry point, in file order. Extractors that pay a fixed
   * cost per invocation (spawning an interpreter, say) implement this so a
   * scan pays it once instead of once per file.
   */
  analyzeMany?(files: Array<{ abs: string; rel: string }>): FileAnalysis[];
}

export const javascriptExtractor: Extractor = {
  name: 'javascript',
  globs: JAVASCRIPT_GLOBS,
  matches: matchesJavascript,
  analyze: analyzeJavascript,
};

export const prismaExtractor: Extractor = {
  name: 'prisma',
  globs: PRISMA_GLOBS,
  matches: matchesPrisma,
  analyze: analyzePrisma,
};

export const sqlExtractor: Extractor = {
  name: 'sql',
  globs: SQL_GLOBS,
  matches: matchesSql,
  analyze: analyzeSql,
};

export const pythonExtractor: Extractor = {
  name: 'python',
  globs: PYTHON_GLOBS,
  matches: matchesPython,
  analyze: analyzePython,
  analyzeMany: analyzePythonMany,
};

export const configExtractor: Extractor = {
  name: 'config',
  globs: CONFIG_GLOBS,
  matches: matchesConfig,
  analyze: analyzeConfig,
};

/**
 * Last in the list: a shallow scanner for languages without a dedicated
 * extractor, so no source file is invisible to a review.
 */
export const genericExtractor: Extractor = {
  name: 'generic',
  globs: GENERIC_GLOBS,
  matches: matchesGeneric,
  analyze: analyzeGeneric,
};

/** Registered extractors, in match order. */
export const extractors: Extractor[] = [
  javascriptExtractor,
  pythonExtractor,
  prismaExtractor,
  sqlExtractor,
  configExtractor,
  genericExtractor,
];

export function extractorFor(file: string): Extractor | undefined {
  return extractors.find((e) => e.matches(file));
}

/** Every glob any extractor claims — the scan set for a snapshot. */
export function extractorGlobs(): string[] {
  return [...new Set(extractors.flatMap((e) => e.globs))];
}
