#!/usr/bin/env node
import * as path from 'path';
import { Command } from 'commander';
import { backfillProject } from './backfill';
import { installHook, uninstallHook } from './hook';
import { listProject, pruneProject } from './list';
import { requireProjectRoot } from './project';
import { ReviewFormat, reviewProject } from './reviewCommand';
import { snapProject } from './snap';
import { viewProject } from './view';
import { watchProject } from './watch';

// __dirname is dist/ at runtime, so this resolves to the package root in both
// a checkout and an installed tarball. Keeps `hiarky --version` honest.
const { version } = require(path.join(__dirname, '..', 'package.json')) as { version: string };

const program = new Command();

program
  .name('hiarky')
  .description(
    'Snapshot what your project declares — components, routes, API procedures, database ' +
      'models, migrations, config — and review how it changes over time'
  )
  .version(version);

program
  .command('snap')
  .description('Snapshot every module-scope symbol in this project into .hiarky/snapshots')
  .option('-f, --force', 'snapshot even if nothing changed since the last one')
  .option('-q, --quiet', 'single-line output (used by hooks and watch mode)')
  .option('--no-cache', 'ignore the per-file analysis cache')
  .action(async (opts: { force?: boolean; quiet?: boolean; cache: boolean }) => {
    await snapProject(requireProjectRoot(), { ...opts, noCache: !opts.cache });
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
  .command('review')
  .argument(
    '[range]',
    'git range to review: `main..HEAD`, `main...HEAD`, or a single rev (defaults to the last two snapshots)'
  )
  .description('Summarize the symbol-level changes in a commit range, ranked by impact')
  .option('--format <format>', 'text | md | github | json', 'text')
  .option('--per-commit', 'report each commit in the range separately')
  .option('--all-files', 'include symbols in files the range never touched')
  .option('--no-cache', 'ignore the per-file analysis cache')
  .action(
    async (
      range: string | undefined,
      opts: { format: string; perCommit?: boolean; allFiles?: boolean; cache: boolean }
    ) => {
      const format = opts.format as ReviewFormat;
      if (!['text', 'md', 'github', 'json'].includes(format)) {
        throw new Error(`unknown --format ${opts.format}; expected text, md, github, or json.`);
      }
      process.stdout.write(
        await reviewProject(requireProjectRoot(), {
          range,
          format,
          perCommit: opts.perCommit,
          allFiles: opts.allFiles,
          noCache: !opts.cache,
        })
      );
    }
  );

program
  .command('watch')
  .description('Watch source files and snapshot automatically on change (deduped)')
  .option('--debounce <ms>', 'settle time after the last change', (v) => parseInt(v, 10), 1500)
  .action(async (opts: { debounce: number }) => {
    const handle = await watchProject(requireProjectRoot(), opts);
    process.on('SIGINT', () => {
      console.log('\nStopping watch.');
      void handle.close().then(() => process.exit(0));
    });
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
  .option('--no-cache', 'ignore the per-file analysis cache')
  .action(async (opts: { max: number; range?: string; cache: boolean }) => {
    await backfillProject(requireProjectRoot(), { ...opts, noCache: !opts.cache });
  });

program.parseAsync().catch((err) => {
  console.error(`hiarky: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
