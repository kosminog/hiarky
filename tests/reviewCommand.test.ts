import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveRange, reviewProject } from '../src/reviewCommand';
import { snapProject } from '../src/snap';
import { cleanup, commitAll, git, initRepo, makeProject, writeFile } from './helpers';

const BUTTON_V1 = `export function Button({ label }: { label: string }) {
  return <button>{label}</button>;
}
`;
const BUTTON_V2 = `export function Button({ label, kind }: { label: string; kind?: string }) {
  return <button className={kind}>{label}</button>;
}
`;
const CARD = `export function Card({ title }: { title: string }) {
  return <div>{title}</div>;
}
`;

let root: string;
const shas: string[] = [];

beforeAll(() => {
  root = makeProject({ 'src/Button.tsx': BUTTON_V1 });
  initRepo(root);
  shas.push(commitAll(root, 'add button', '2026-01-01T00:00:00Z'));
  writeFile(root, 'src/Button.tsx', BUTTON_V2);
  shas.push(commitAll(root, 'button gains kind', '2026-01-02T00:00:00Z'));
  writeFile(root, 'src/Card.tsx', CARD);
  shas.push(commitAll(root, 'add card', '2026-01-03T00:00:00Z'));
});

afterAll(() => cleanup(root));

describe('resolveRange', () => {
  it('resolves `a..b`', () => {
    expect(resolveRange(root, `${shas[0]}..${shas[1]}`)).toEqual({
      base: shas[0],
      head: shas[1],
    });
  });

  it('treats a bare rev as `<rev>..HEAD`', () => {
    expect(resolveRange(root, shas[0])).toEqual({ base: shas[0], head: shas[2] });
  });

  it('resolves `a...b` through the merge base', () => {
    git(root, ['checkout', '-q', '-b', 'side', shas[0]]);
    writeFile(root, 'src/Side.tsx', 'export const Side = () => <i />;\n');
    const sideSha = commitAll(root, 'side work', '2026-01-04T00:00:00Z');
    git(root, ['checkout', '-q', 'main']);
    // `main...side` compares side against where the branches diverged
    expect(resolveRange(root, `main...${sideSha}`)).toEqual({
      base: shas[0],
      head: sideSha,
    });
    git(root, ['branch', '-q', '-D', 'side']);
  });
});

describe('reviewProject over a commit range', () => {
  it('reports a prop addition as a change on the public surface', async () => {
    const out = await reviewProject(root, { range: `${shas[0]}..${shas[1]}`, format: 'text' });
    expect(out).toContain('src/Button.tsx#Button');
    expect(out).toContain('props: +kind');
    expect(out).toContain('public surface touched in 1 file(s)');
  });

  it('summarizes an added file as a new file', async () => {
    const out = await reviewProject(root, { range: `${shas[1]}..${shas[2]}`, format: 'text' });
    expect(out).toContain('NEW FILES (1)');
    expect(out).toContain('src/Card.tsx — 1 symbol, 1 exported');
  });

  it('counts commits and touched files in the header', async () => {
    const out = await reviewProject(root, { range: `${shas[0]}..${shas[2]}`, format: 'text' });
    expect(out).toContain('2 commits');
    expect(out).toContain('2 files touched');
  });

  it('renders markdown on request', async () => {
    const out = await reviewProject(root, { range: `${shas[0]}..${shas[1]}`, format: 'md' });
    expect(out).toContain('## hiarky review');
    expect(out).toContain('- **Button** changed');
  });

  it('renders github-flavored markdown on request', async () => {
    const out = await reviewProject(root, { range: `${shas[0]}..${shas[1]}`, format: 'github' });
    expect(out).toContain('| **Impact** |');
    expect(out).toContain('| `Button` · props | | `+kind` |');
    expect(out).toContain('<details><summary>Full report</summary>');
  });

  it('renders machine-readable json', async () => {
    const out = await reviewProject(root, { range: `${shas[0]}..${shas[1]}`, format: 'json' });
    const parsed = JSON.parse(out);
    expect(parsed.from).toBe(shas[0].slice(0, 7));
    expect(parsed.review.changes[0]).toMatchObject({
      id: 'src/Button.tsx#Button',
      kind: 'changed',
      exported: true,
    });
    expect(parsed.review.changes[0].deltas).toContainEqual({
      field: 'members',
      added: ['kind'],
    });
  });

  it('reports each commit separately with --per-commit', async () => {
    const out = await reviewProject(root, {
      range: `${shas[0]}..${shas[2]}`,
      format: 'text',
      perCommit: true,
    });
    expect(out).toContain('button gains kind');
    expect(out).toContain('add card');
    expect(out.indexOf('button gains kind')).toBeLessThan(out.indexOf('add card'));
  });

  it('says so when a range changes no symbols', async () => {
    const empty = commitAll(root, 'docs only', '2026-01-05T00:00:00Z');
    const out = await reviewProject(root, { range: `${shas[2]}..${empty}`, format: 'text' });
    expect(out).toContain('No symbol-level changes');
  });
});

describe('reviewProject without a range', () => {
  it('explains what to do when there are not two snapshots', async () => {
    const bare = makeProject({ 'src/A.tsx': 'export const A = () => <p />;\n' });
    try {
      await expect(reviewProject(bare, { format: 'text' })).rejects.toThrow(
        'at least two snapshots'
      );
    } finally {
      cleanup(bare);
    }
  });

  it('compares the two most recent snapshots on disk', async () => {
    const local = makeProject({ 'src/A.tsx': 'export const A = () => <p />;\n' });
    try {
      await snapProject(local, { quiet: true });
      writeFile(local, 'src/A.tsx', 'export const A = ({ x }: { x: number }) => <p>{x}</p>;\n');
      await snapProject(local, { quiet: true });
      const out = await reviewProject(local, { format: 'text' });
      expect(out).toContain('src/A.tsx#A');
      expect(out).toContain('props: +x');
    } finally {
      cleanup(local);
    }
  });
});
