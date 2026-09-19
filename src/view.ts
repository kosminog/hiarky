import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { readProjectName } from './project';
import { loadSnapshots } from './snap';
import { buildViewerHtml } from './viewer';

export function viewProject(root: string, options: { open: boolean }): void {
  const snapshots = loadSnapshots(root);
  if (snapshots.length === 0) {
    throw new Error('no snapshots found. Run `hiarky snap` first.');
  }

  const html = buildViewerHtml(snapshots, readProjectName(root));
  const outFile = path.join(root, '.hiarky', 'view.html');
  fs.writeFileSync(outFile, html);
  console.log(
    `Generated viewer with ${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'}: ` +
      path.relative(process.cwd(), outFile)
  );

  if (options.open) {
    const cmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(cmd, [outFile], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' })
      .on('error', () => console.log('Could not open a browser automatically; open the file above manually.'))
      .unref();
  }
}
