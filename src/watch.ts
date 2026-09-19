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

export async function watchProject(root: string, opts: { debounce: number }): Promise<void> {
  const stamp = () => new Date().toTimeString().slice(0, 8);

  // Baseline snapshot (deduped, so a no-op if nothing changed since the last one)
  await snapProject(root, { quiet: true });

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let rerun = false;

  const takeSnapshot = async () => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      await snapProject(root, { quiet: true });
    } catch (err) {
      console.error(`[${stamp()}] snapshot failed: ${err instanceof Error ? err.message : err}`);
    }
    running = false;
    if (rerun) {
      rerun = false;
      void takeSnapshot();
    }
  };

  const schedule = (file: string) => {
    console.log(`[${stamp()}] change: ${path.relative(root, file)}`);
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

  console.log(`Watching ${root} (debounce ${opts.debounce}ms). Press Ctrl+C to stop.`);

  process.on('SIGINT', () => {
    console.log('\nStopping watch.');
    void watcher.close().then(() => process.exit(0));
  });

  // Keep the process alive until SIGINT
  await new Promise(() => {});
}
