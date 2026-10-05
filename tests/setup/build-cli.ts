import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Absolute path of a `dist/index.js` compiled from this checkout for the run. */
    cliPath: string;
  }
}

/**
 * Compile the CLI once for the whole run, into a scratch package that mirrors
 * an installed copy: `dist/` beside a `package.json` (for `--version`) and a
 * `node_modules` link (for the runtime dependencies). Tests that spawn the
 * binary read it with `inject('cliPath')`, so they never depend on a stale or
 * missing `dist/` in the checkout.
 */
export default async function setup(project: TestProject): Promise<() => void> {
  const root = path.resolve(__dirname, '..', '..');
  const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiarky-cli-'));
  execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      path.join(root, 'tsconfig.json'),
      '--outDir',
      path.join(pkgDir, 'dist'),
    ],
    { cwd: root, stdio: 'inherit' }
  );
  fs.copyFileSync(path.join(root, 'package.json'), path.join(pkgDir, 'package.json'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(pkgDir, 'node_modules'), 'dir');

  project.provide('cliPath', path.join(pkgDir, 'dist', 'index.js'));
  return () => fs.rmSync(pkgDir, { recursive: true, force: true });
}
