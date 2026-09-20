import { extractorFor } from './extractors';
import { FileAnalysis } from './types';

/**
 * Analyze one source file with whichever extractor claims it.
 * Files no extractor handles yield an empty analysis rather than an error.
 */
export function analyzeFile(absFile: string, relFile: string): FileAnalysis {
  const extractor = extractorFor(relFile);
  if (!extractor) {
    return { file: relFile, symbols: [], imports: [], reexports: [] };
  }
  return extractor.analyze(absFile, relFile);
}

export { extractors, extractorFor, extractorGlobs } from './extractors';
export type { Extractor } from './extractors';
