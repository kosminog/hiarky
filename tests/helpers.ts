import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Create a throwaway project in a temp directory.
 * `files` maps relative paths to contents; a package.json is added unless provided.
 * Returns the realpath (macOS tmpdir is a symlink, which breaks path.relative
 * against git's resolved --show-toplevel).
 */
export function makeProject(files: Record<string, string> = {}): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiarky-test-')));
  if (!('package.json' in files)) {
    writeFile(dir, 'package.json', JSON.stringify({ name: 'scratch', private: true }));
  }
  for (const [rel, content] of Object.entries(files)) writeFile(dir, rel, content);
  return dir;
}

export function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

export function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...env } })
    .toString()
    .trim();
}

/** git init with a local test identity, so tests don't depend on global config. */
export function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

/** Commit everything with a fixed author/committer date; returns the sha. */
export function commitAll(dir: string, message: string, isoDate: string): string {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', message], {
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_DATE: isoDate,
  });
  return git(dir, ['rev-parse', 'HEAD']);
}

export function snapshotFiles(root: string): string[] {
  const dir = path.join(root, '.hiarky', 'snapshots');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.snapshot'))
    .sort();
}

export const BUTTON_TSX = `export function Button({ label }: { label: string }) {
  return <button>{label}</button>;
}
`;

export const APP_TSX = `import { Button } from './Button';

export default function App() {
  return <Button label="go" />;
}
`;
