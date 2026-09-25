import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { FileAnalysis } from './types';

/**
 * Bump when extractor output changes shape or content, so stale entries from
 * an older build are never served. Deleting .hiarky/cache has the same effect.
 */
const CACHE_VERSION = 3;

/** Entries kept on disk; oldest-used are dropped past this. */
const MAX_ENTRIES = 5000;

function cacheFile(root: string): string {
  return path.join(root, '.hiarky', 'cache', `analysis-v${CACHE_VERSION}.json`);
}

function sha(text: string | Buffer): string {
  return createHash('sha1').update(text).digest('hex');
}

/**
 * A content fingerprint per file, used as the cache key.
 *
 * Git already hashes every tracked file, so `git ls-files -s` gives the whole
 * set in one call. Only files git reports as modified need reading — and in a
 * backfill worktree, none are.
 */
export function contentKeys(scanRoot: string, files: string[]): Map<string, string> {
  const wanted = new Set(files);
  const keys = new Map<string, string>();

  try {
    const listed = execFileSync('git', ['ls-files', '-s', '-z'], {
      cwd: scanRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
    }).toString();
    for (const entry of listed.split('\0')) {
      if (!entry) continue;
      // <mode> <sha> <stage>\t<path>
      const tab = entry.indexOf('\t');
      if (tab === -1) continue;
      const rel = entry.slice(tab + 1);
      if (!wanted.has(rel)) continue;
      const blob = entry.slice(0, tab).split(/\s+/)[1];
      if (blob) keys.set(rel, blob);
    }

    // The index sha is stale for anything modified in the working tree
    const status = execFileSync('git', ['status', '--porcelain', '-z'], {
      cwd: scanRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
    }).toString();
    for (const entry of status.split('\0')) {
      if (entry.length < 4) continue;
      keys.delete(entry.slice(3));
    }
  } catch {
    // not a git repository; fall through to hashing
  }

  for (const rel of files) {
    if (keys.has(rel)) continue;
    try {
      keys.set(rel, sha(fs.readFileSync(path.join(scanRoot, rel))));
    } catch {
      // unreadable: leave it uncached rather than guessing
    }
  }
  return keys;
}

export interface CacheStats {
  hits: number;
  misses: number;
}

export interface AnalysisCache {
  get(extractor: string, rel: string, contentKey: string | undefined): FileAnalysis | null;
  set(extractor: string, rel: string, contentKey: string | undefined, analysis: FileAnalysis): void;
  flush(): void;
  readonly stats: CacheStats;
}

/** A cache that stores nothing, for --no-cache and for callers that opt out. */
export function nullCache(): AnalysisCache {
  const stats = { hits: 0, misses: 0 };
  return {
    get: () => null,
    set: () => undefined,
    flush: () => undefined,
    stats,
  };
}

/**
 * Per-file analysis results keyed by content, so re-analyzing history only
 * parses what actually changed between commits.
 *
 * Entries are stored serialized and parsed on read: linking mutates the
 * analysis it is given, so every caller must get its own copy.
 */
export function openCache(root: string): AnalysisCache {
  const file = cacheFile(root);
  const entries = new Map<string, string>();
  const stats: CacheStats = { hits: 0, misses: 0 };
  let dirty = false;

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      version: number;
      entries: Array<[string, string]>;
    };
    if (raw.version === CACHE_VERSION) {
      for (const [key, value] of raw.entries) entries.set(key, value);
    }
  } catch {
    // no cache yet, or unreadable; start empty
  }

  const keyOf = (extractor: string, rel: string, contentKey: string) =>
    `${extractor}\0${rel}\0${contentKey}`;

  return {
    stats,
    get(extractor, rel, contentKey) {
      if (!contentKey) return null;
      const key = keyOf(extractor, rel, contentKey);
      const hit = entries.get(key);
      if (hit === undefined) {
        stats.misses++;
        return null;
      }
      stats.hits++;
      // Refresh recency so the eviction below keeps what is in use
      entries.delete(key);
      entries.set(key, hit);
      try {
        return JSON.parse(hit) as FileAnalysis;
      } catch {
        entries.delete(key);
        return null;
      }
    },
    set(extractor, rel, contentKey, analysis) {
      if (!contentKey) return;
      entries.set(keyOf(extractor, rel, contentKey), JSON.stringify(analysis));
      dirty = true;
    },
    flush() {
      if (!dirty) return;
      const kept = [...entries.entries()].slice(-MAX_ENTRIES);
      try {
        const dir = path.dirname(file);
        fs.mkdirSync(dir, { recursive: true });
        // Derived data: keep it out of the user's git status entirely
        const ignore = path.join(dir, '.gitignore');
        if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
        fs.writeFileSync(file, JSON.stringify({ version: CACHE_VERSION, entries: kept }));
        dirty = false;
      } catch {
        // a cache that cannot be written is not an error worth failing a scan for
      }
    },
  };
}
