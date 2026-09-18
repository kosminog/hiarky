#!/usr/bin/env node
import { Command } from 'commander';
import { runSnap } from './snap';
import { runView } from './view';

const program = new Command();

program
  .name('hiarky')
  .description('Track React component hierarchy, props, and hooks over time through snapshots')
  .version('0.1.0');

program
  .command('snap')
  .description('Snapshot the current React component hierarchy into .hiarky/snapshots')
  .action(async () => {
    await runSnap();
  });

program
  .command('view')
  .description('Generate an HTML viewer for all snapshots and open it in a browser')
  .option('--no-open', 'generate the file without opening a browser')
  .action((opts: { open: boolean }) => {
    runView(opts);
  });

program.parseAsync().catch((err) => {
  console.error(`hiarky: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
