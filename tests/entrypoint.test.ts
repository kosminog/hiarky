import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_TSX, BUTTON_TSX, cleanup, makeProject, runCli, snapshotFiles, writeFile } from './helpers';

const { version } = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
  version: string;
};

// The commander wiring in src/index.ts, driven through the compiled binary the
// way a user runs it. Each command's behaviour has its own tests; this checks
// that the entry point reaches them, and what a shell sees on the way out.
describe('hiarky binary', () => {
  let root: string;

  beforeAll(() => {
    root = makeProject({ 'src/App.tsx': APP_TSX, 'src/Button.tsx': BUTTON_TSX });
  });
  afterAll(() => cleanup(root));

  it('reports the package version', () => {
    const { status, stdout } = runCli(root, ['--version']);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(version);
  });

  it('lists every command in --help', () => {
    const { status, stdout } = runCli(root, ['--help']);
    expect(status).toBe(0);
    for (const cmd of [
      'snap',
      'view',
      'list',
      'prune',
      'review',
      'watch',
      'install-hook',
      'uninstall-hook',
      'backfill',
    ]) {
      expect(stdout).toMatch(new RegExp(`^  ${cmd}\\b`, 'm'));
    }
  });

  it('snaps, lists, and views a project', () => {
    const snap = runCli(root, ['snap']);
    expect(snap.status).toBe(0);
    expect(snap.stdout).toContain('Snapped 2 symbols (2 components)');
    expect(snapshotFiles(root)).toHaveLength(1);

    const again = runCli(root, ['snap', '--quiet']);
    expect(again.status).toBe(0);
    expect(again.stdout.trim()).toBe('hiarky: no changes; snapshot skipped');
    expect(snapshotFiles(root)).toHaveLength(1);

    const list = runCli(root, ['list']);
    expect(list.status).toBe(0);
    const lines = list.stdout.trim().split('\n');
    expect(lines[0]).toMatch(/^#\s+TIMESTAMP\s+COMMIT\s+COMPONENTS\s+CHANGES\s+ID/);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^1\s+\d{4}-\d\d-\d\d \d\d:\d\d:\d\dZ\s+-\s+2\b/);

    const view = runCli(root, ['view', '--no-open']);
    expect(view.status).toBe(0);
    expect(view.stdout).toContain('Generated viewer with 1 snapshot');
    expect(fs.existsSync(path.join(root, '.hiarky', 'view.html'))).toBe(true);
  });

  it('reviews the last two snapshots once there are two', () => {
    const early = runCli(root, ['review']);
    expect(early.status).toBe(1);
    expect(early.stdout).toBe('');
    expect(early.stderr).toContain('hiarky: need at least two snapshots to review');

    writeFile(root, 'src/Extra.tsx', 'export const Extra = () => <p />;\n');
    expect(runCli(root, ['snap', '--quiet']).status).toBe(0);

    const review = runCli(root, ['review', '--format', 'json']);
    expect(review.status).toBe(0);
    const report = JSON.parse(review.stdout) as {
      from: string;
      to: string;
      review: { changes: Array<{ kind: string; name: string }> };
    };
    expect(report.from).toBeTruthy();
    expect(report.to).toBeTruthy();
    expect(report.review.changes).toEqual([expect.objectContaining({ kind: 'added', name: 'Extra' })]);
  });

  it('rejects an unknown --format with a message and exit code 1', () => {
    const { status, stdout, stderr } = runCli(root, ['review', '--format', 'nope']);
    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr.trim()).toBe(
      'hiarky: unknown --format nope; expected text, md, github, actions, or json.'
    );
  });

  it('exits 1 on a commander usage error', () => {
    const { status, stderr } = runCli(root, ['prune']);
    expect(status).toBe(1);
    expect(stderr).toContain("required option '--keep <n>' not specified");
  });

  it('prunes with --dry-run before pruning for real', () => {
    expect(snapshotFiles(root)).toHaveLength(2);
    const dry = runCli(root, ['prune', '--keep', '1', '--dry-run']);
    expect(dry.status).toBe(0);
    expect(snapshotFiles(root)).toHaveLength(2);
    const real = runCli(root, ['prune', '--keep', '1']);
    expect(real.status).toBe(0);
    expect(snapshotFiles(root)).toHaveLength(1);
  });
});
