import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { findProjectRoot } from './project';

const MARKER = '# hiarky-hook';

function hookFilePath(root: string): string | null {
  try {
    const hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return path.resolve(root, hooksDir, 'post-commit');
  } catch {
    return null;
  }
}

function hookScript(projectRoot: string): string {
  return `#!/bin/sh
${MARKER} v1 — take a hiarky snapshot after every commit (installed by \`hiarky install-hook\`)
cd "${projectRoot}" || exit 0
if command -v hiarky >/dev/null 2>&1; then
  hiarky snap --quiet
elif command -v npx >/dev/null 2>&1; then
  npx --no-install hiarky snap --quiet
fi
exit 0
`;
}

export function runInstallHook(opts: { force?: boolean }): void {
  const root = findProjectRoot(process.cwd());
  if (!root) {
    console.error('hiarky: no package.json found in this directory or any parent.');
    process.exitCode = 1;
    return;
  }
  const hookFile = hookFilePath(root);
  if (!hookFile) {
    console.error('hiarky: not inside a git repository.');
    process.exitCode = 1;
    return;
  }

  if (fs.existsSync(hookFile)) {
    const existing = fs.readFileSync(hookFile, 'utf8');
    if (!existing.includes(MARKER) && !opts.force) {
      console.error(
        `hiarky: a post-commit hook already exists at ${hookFile}.\n` +
          'Re-run with --force to overwrite it, or add `hiarky snap --quiet` to it manually.'
      );
      process.exitCode = 1;
      return;
    }
  }

  fs.mkdirSync(path.dirname(hookFile), { recursive: true });
  fs.writeFileSync(hookFile, hookScript(root), { mode: 0o755 });
  console.log(`Installed post-commit hook: ${hookFile}`);
  console.log(`Every commit in this repository will now snapshot ${root}.`);
}

export function runUninstallHook(): void {
  const root = findProjectRoot(process.cwd());
  if (!root) {
    console.error('hiarky: no package.json found in this directory or any parent.');
    process.exitCode = 1;
    return;
  }
  const hookFile = hookFilePath(root);
  if (!hookFile || !fs.existsSync(hookFile)) {
    console.log('No post-commit hook installed.');
    return;
  }
  const existing = fs.readFileSync(hookFile, 'utf8');
  if (!existing.includes(MARKER)) {
    console.error(
      `hiarky: the post-commit hook at ${hookFile} was not installed by hiarky; leaving it alone.`
    );
    process.exitCode = 1;
    return;
  }
  fs.unlinkSync(hookFile);
  console.log(`Removed post-commit hook: ${hookFile}`);
}
