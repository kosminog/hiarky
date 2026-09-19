#!/usr/bin/env node
import { Command } from 'commander';
import { backfillProject } from './backfill';
import { installHook, uninstallHook } from './hook';
import { listProject, pruneProject } from './list';
import { requireProjectRoot } from './project';
import { snapProject } from './snap';
import { viewProject } from './view';
import { watchProject } from './watch';

const program = new Command();

program
  .name('hiarky')
  .description('Track React component hierarchy, props, and hooks over time through snapshots')
  .version('0.1.0');

program
  .command('snap')
  .description('Snapshot the current React component hierarchy into .hiarky/snapshots')
  .option('-f, --force', 'snapshot even if nothing changed since the last one')
  .option('-q, --quiet', 'single-line output (used by hooks and watch mode)')
  .action(async (opts: { force?: boolean; quiet?: boolean }) => {
    await snapProject(requireProjectRoot(), opts);
  });

program
  .command('view')
  .description('Generate an HTML viewer for all snapshots and open it in a browser')
  .option('--no-open', 'generate the file without opening a browser')
  .action((opts: { open: boolean }) => {
    viewProject(requireProjectRoot(), opts);
  });

program
  .command('list')
  .description('List all snapshots with commit info and changes since the previous one')
  .action(() => {
    listProject(requireProjectRoot());
  });

program
  .command('prune')
  .description('Delete old snapshots, keeping the most recent N')
  .requiredOption('--keep <n>', 'number of snapshots to keep', (v) => parseInt(v, 10))
  .option('--dry-run', 'show what would be deleted without deleting')
  .action((opts: { keep: number; dryRun?: boolean }) => {
    pruneProject(requireProjectRoot(), opts);
  });

program
  .command('watch')
  .description('Watch source files and snapshot automatically on change (deduped)')
  .option('--debounce <ms>', 'settle time after the last change', (v) => parseInt(v, 10), 1500)
  .action(async (opts: { debounce: number }) => {
    await watchProject(requireProjectRoot(), opts);
  });

program
  .command('install-hook')
  .description('Install a git post-commit hook that snapshots this project on every commit')
  .option('-f, --force', 'overwrite an existing post-commit hook')
  .action((opts: { force?: boolean }) => {
    installHook(requireProjectRoot(), opts);
  });

program
  .command('uninstall-hook')
  .description('Remove the git post-commit hook installed by hiarky')
  .action(() => {
    uninstallHook(requireProjectRoot());
  });

program
  .command('backfill')
  .description('Snapshot past git commits retroactively (timestamps taken from commit dates)')
  .option('--max <n>', 'limit to the most recent N commits', (v) => parseInt(v, 10), 100)
  .option('--range <range>', 'git rev range to backfill (default: HEAD history)')
  .action(async (opts: { max: number; range?: string }) => {
    await backfillProject(requireProjectRoot(), opts);
  });

program.parseAsync().catch((err) => {
  console.error(`hiarky: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
