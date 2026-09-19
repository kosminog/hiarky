import * as path from 'path';
import chokidar from 'chokidar';
import { snapProject } from './snap';

const SOURCE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hiarky',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  '__tests__',
  '__mocks__',
]);

function inIgnoredDir(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel.split(path.sep).some((seg) => IGNORED_DIRS.has(seg));
}

function isSourceFile(file: string): boolean {
  const base = path.basename(file);
  if (!SOURCE_EXTS.has(path.extname(base))) return false;
  if (base.endsWith('.d.ts')) return false;
  if (/\.(test|spec)\.[^.]+$/.test(base)) return false;
  return true;
}

export interface WatchOptions {
  debounce: number;
  /** Called after every snapshot attempt (the baseline included) with whether one was written. */
  onSnapshot?: (written: boolean) => void;
  quiet?: boolean;
}

export interface WatchHandle {
  close(): Promise<void>;
}

/**
 * Watch a project and snapshot on change. Resolves once watching is active;
 * the returned handle stops the watcher. The chokidar watcher keeps the
 * process alive, so the CLI needs no extra keep-alive.
 */
export async function watchProject(root: string, opts: WatchOptions): Promise<WatchHandle> {
  const stamp = () => new Date().toTimeString().slice(0, 8);
  const log = (msg: string) => {
    if (!opts.quiet) console.log(msg);
  };

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let rerun = false;
  let closed = false;

  const takeSnapshot = async () => {
    if (closed) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      const written = await snapProject(root, { quiet: true });
      opts.onSnapshot?.(written);
    } catch (err) {
      console.error(`[${stamp()}] snapshot failed: ${err instanceof Error ? err.message : err}`);
    }
    running = false;
    if (rerun) {
      rerun = false;
      void takeSnapshot();
    }
  };

  // Baseline snapshot (deduped, so a no-op if nothing changed since the last one)
  await takeSnapshot();

  const schedule = (file: string) => {
    log(`[${stamp()}] change: ${path.relative(root, file)}`);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void takeSnapshot(), opts.debounce);
  };

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (file) => inIgnoredDir(root, file),
  });

  watcher.on('all', (event, file) => {
    if (!['add', 'change', 'unlink'].includes(event)) return;
    if (!isSourceFile(file)) return;
    schedule(file);
  });

  await new Promise<void>((resolve) => watcher.on('ready', () => resolve()));
  log(`Watching ${root} (debounce ${opts.debounce}ms). Press Ctrl+C to stop.`);

  return {
    close: async () => {
      closed = true;
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
