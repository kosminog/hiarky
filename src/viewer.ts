import { Snapshot } from './types';

/**
 * Build a fully self-contained HTML viewer with all snapshot data embedded.
 * No network requests, no external assets — the file works from disk.
 */
export function buildViewerHtml(snapshots: Snapshot[], projectName: string): string {
  const data = JSON.stringify(snapshots).replace(/<\//g, '<\\/');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hiarky — ${escapeHtml(projectName)}</title>
<style>
  :root {
    --bg: #ffffff; --panel: #f6f7f9; --border: #e2e5ea; --text: #1c2128;
    --muted: #6b7280; --accent: #4f6ef7; --accent-soft: #e8ecfe;
    --added: #16a34a; --removed: #dc2626; --changed: #d97706;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --panel: #171a21; --border: #2a2f3a; --text: #e6e8ec;
      --muted: #8b93a1; --accent: #7a90ff; --accent-soft: #232a45;
      --added: #4ade80; --removed: #f87171; --changed: #fbbf24;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    height: 100vh; display: flex; flex-direction: column;
  }
  header {
    display: flex; align-items: baseline; gap: 12px; padding: 10px 16px;
    border-bottom: 1px solid var(--border); flex: none;
  }
  header h1 { font-size: 15px; margin: 0; }
  header .project { color: var(--muted); }
  header .hint { margin-left: auto; color: var(--muted); font-size: 12px; }
  kbd {
    font-family: var(--mono); font-size: 11px; padding: 1px 5px;
    border: 1px solid var(--border); border-radius: 4px; background: var(--panel);
  }
  main { display: flex; flex: 1; min-height: 0; }
  .timeline {
    width: 270px; flex: none; overflow-y: auto; border-right: 1px solid var(--border);
    background: var(--panel); padding: 8px;
  }
  .snap-item {
    width: 100%; text-align: left; display: block; padding: 8px 10px; margin-bottom: 6px;
    border: 1px solid var(--border); border-radius: 8px; background: var(--bg);
    color: inherit; cursor: pointer; font: inherit;
  }
  .snap-item:hover { border-color: var(--accent); }
  .snap-item.active { border-color: var(--accent); background: var(--accent-soft); }
  .snap-time { font-weight: 600; }
  .snap-meta { color: var(--muted); font-size: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
  .snap-meta .commit { font-family: var(--mono); }
  .badge { font-size: 11px; font-weight: 600; }
  .badge.added { color: var(--added); }
  .badge.removed { color: var(--removed); }
  .badge.changed { color: var(--changed); }
  .tree-pane { flex: 1; overflow: auto; padding: 14px 18px; }
  .tree-pane h2, .detail h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--muted); margin: 0 0 8px;
  }
  ul.tree { list-style: none; margin: 0; padding-left: 0; }
  ul.tree ul { list-style: none; padding-left: 20px; border-left: 1px solid var(--border); margin-left: 7px; }
  .node-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
  .caret {
    width: 16px; height: 16px; flex: none; border: none; background: none; color: var(--muted);
    cursor: pointer; padding: 0; font-size: 10px; line-height: 16px;
  }
  .caret.leaf { visibility: hidden; }
  .node-name {
    border: none; background: none; color: inherit; font: inherit; cursor: pointer;
    padding: 1px 6px; border-radius: 5px; font-weight: 600;
  }
  .node-name:hover { background: var(--accent-soft); }
  .node-name.selected { background: var(--accent); color: #fff; }
  .node-name.external { color: var(--muted); font-weight: 400; cursor: default; }
  .node-name.external:hover { background: none; }
  .pkg { color: var(--muted); font-size: 11px; font-family: var(--mono); }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .dot.added { background: var(--added); }
  .dot.changed { background: var(--changed); }
  .hookcount { color: var(--muted); font-size: 11px; }
  .cycle { color: var(--muted); font-size: 11px; font-style: italic; }
  .removed-list { margin-top: 16px; }
  .removed-list li { color: var(--removed); font-family: var(--mono); font-size: 12px; }
  .detail {
    width: 320px; flex: none; overflow-y: auto; border-left: 1px solid var(--border);
    background: var(--panel); padding: 14px 16px;
  }
  .detail .placeholder { color: var(--muted); }
  .detail h3 { margin: 0 0 2px; font-size: 16px; }
  .detail .file { font-family: var(--mono); font-size: 11px; color: var(--muted); word-break: break-all; }
  .detail section { margin-top: 14px; }
  .detail ul { margin: 4px 0 0; padding-left: 0; list-style: none; }
  .detail li { padding: 3px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .detail li:last-child { border-bottom: none; }
  .detail .hook-name { font-family: var(--mono); color: var(--accent); }
  .detail .hook-detail { color: var(--muted); font-family: var(--mono); font-size: 12px; }
  .detail .prop { font-family: var(--mono); font-size: 12px; }
  .tag {
    display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 4px;
    border: 1px solid var(--border); color: var(--muted); margin-right: 4px;
  }
  .empty { color: var(--muted); font-size: 12px; }
  .link { color: var(--accent); cursor: pointer; text-decoration: underline; background: none; border: none; font: inherit; padding: 0; }
</style>
</head>
<body>
<header>
  <h1>hiarky</h1>
  <span class="project">${escapeHtml(projectName)}</span>
  <span class="hint"><kbd>&larr;</kbd> <kbd>&rarr;</kbd> to move between snapshots</span>
</header>
<main>
  <nav class="timeline" id="timeline"></nav>
  <div class="tree-pane">
    <h2>Component tree</h2>
    <div id="tree"></div>
    <div id="removed" class="removed-list"></div>
  </div>
  <aside class="detail" id="detail"></aside>
</main>
<script>
const SNAPSHOTS = ${data};

let current = SNAPSHOTS.length - 1;
let selectedId = null;
const collapsed = new Set();

const byId = (snap) => {
  const m = new Map();
  for (const c of snap.components) m.set(c.id, c);
  return m;
};

function sig(c) {
  return JSON.stringify([c.props, c.hooks, c.renders.map(r => r.name).sort()]);
}

function diffWithPrev(i) {
  const cur = byId(SNAPSHOTS[i]);
  const added = new Set(), removed = [], changed = new Set();
  if (i === 0) return { added, removed, changed };
  const prev = byId(SNAPSHOTS[i - 1]);
  for (const [id, c] of cur) {
    if (!prev.has(id)) added.add(id);
    else if (sig(prev.get(id)) !== sig(c)) changed.add(id);
  }
  for (const id of prev.keys()) if (!cur.has(id)) removed.push(id);
  return { added, removed, changed };
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.append(c.nodeType ? c : document.createTextNode(c));
  }
  return e;
}

function renderTimeline() {
  const nav = document.getElementById('timeline');
  nav.textContent = '';
  SNAPSHOTS.forEach((s, i) => {
    const { added, removed, changed } = diffWithPrev(i);
    const badges = [];
    if (added.size) badges.push(el('span', { class: 'badge added' }, '+' + added.size));
    if (removed.length) badges.push(el('span', { class: 'badge removed' }, '\\u2212' + removed.length));
    if (changed.size) badges.push(el('span', { class: 'badge changed' }, '~' + changed.size));
    const meta = el('div', { class: 'snap-meta' },
      s.git ? el('span', { class: 'commit' }, s.git.commit.slice(0, 7) + (s.git.dirty ? '*' : '')) : null,
      el('span', {}, s.stats.components + ' components'),
      ...badges
    );
    nav.append(el('button', {
      class: 'snap-item' + (i === current ? ' active' : ''),
      onclick: () => { current = i; render(); }
    }, el('div', { class: 'snap-time' }, fmtTime(s.timestamp)), meta));
  });
  const active = nav.querySelector('.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function renderNode(comp, map, diff, path) {
  const isCycle = path.includes(comp.id);
  const children = isCycle ? [] : comp.renders;
  const hasKids = children.length > 0;
  const isCollapsed = collapsed.has(comp.id);

  const row = el('div', { class: 'node-row' },
    el('button', {
      class: 'caret' + (hasKids ? '' : ' leaf'),
      onclick: () => {
        if (isCollapsed) collapsed.delete(comp.id); else collapsed.add(comp.id);
        render();
      }
    }, isCollapsed ? '\\u25B6' : '\\u25BC'),
    diff.added.has(comp.id) ? el('span', { class: 'dot added', title: 'added since previous snapshot' }) :
      diff.changed.has(comp.id) ? el('span', { class: 'dot changed', title: 'changed since previous snapshot' }) : null,
    el('button', {
      class: 'node-name' + (comp.id === selectedId ? ' selected' : ''),
      onclick: () => { selectedId = comp.id; render(); }
    }, comp.name),
    comp.hooks.length ? el('span', { class: 'hookcount' }, comp.hooks.length + ' hook' + (comp.hooks.length > 1 ? 's' : '')) : null,
    isCycle ? el('span', { class: 'cycle' }, '(recursive)') : null
  );

  const li = el('li', {}, row);
  if (hasKids && !isCollapsed) {
    const ul = el('ul', {});
    for (const child of children) {
      if (child.id && map.has(child.id)) {
        ul.append(renderNode(map.get(child.id), map, diff, [...path, comp.id]));
      } else {
        ul.append(el('li', {}, el('div', { class: 'node-row' },
          el('button', { class: 'caret leaf' }, ''),
          el('span', { class: 'node-name external' }, child.name),
          child.external ? el('span', { class: 'pkg' }, child.external) : null
        )));
      }
    }
    li.append(ul);
  }
  return li;
}

function renderTree() {
  const snap = SNAPSHOTS[current];
  const map = byId(snap);
  const diff = diffWithPrev(current);
  const container = document.getElementById('tree');
  container.textContent = '';
  const ul = el('ul', { class: 'tree' });
  const roots = snap.roots.filter(id => map.has(id));
  if (roots.length === 0 && snap.components.length > 0) {
    // Fully cyclic graph fallback: show everything top-level
    for (const c of snap.components) ul.append(renderNode(c, map, diff, []));
  } else {
    for (const id of roots) ul.append(renderNode(map.get(id), map, diff, []));
  }
  if (snap.components.length === 0) {
    container.append(el('p', { class: 'empty' }, 'No components in this snapshot.'));
  }
  container.append(ul);

  const removedBox = document.getElementById('removed');
  removedBox.textContent = '';
  if (diff.removed.length) {
    removedBox.append(el('h2', {}, 'Removed since previous snapshot'));
    const rl = el('ul', {});
    for (const id of diff.removed) rl.append(el('li', {}, id));
    removedBox.append(rl);
  }
}

function renderDetail() {
  const box = document.getElementById('detail');
  box.textContent = '';
  const snap = SNAPSHOTS[current];
  const comp = snap.components.find(c => c.id === selectedId);
  if (!comp) {
    box.append(el('p', { class: 'placeholder' }, 'Select a component to inspect its props, hooks, and children.'));
    return;
  }
  box.append(
    el('h3', {}, comp.name),
    el('div', { class: 'file' }, comp.file),
    el('div', { style: 'margin-top:6px' },
      el('span', { class: 'tag' }, comp.kind),
      el('span', { class: 'tag' }, comp.export === 'none' ? 'not exported' : comp.export + ' export')
    )
  );

  const section = (title, items, renderItem) => {
    const s = el('section', {}, el('h2', {}, title));
    if (!items.length) s.append(el('p', { class: 'empty' }, 'none'));
    else {
      const ul = el('ul', {});
      for (const it of items) ul.append(renderItem(it));
      s.append(ul);
    }
    return s;
  };

  box.append(section('Props', comp.props, p => el('li', {}, el('span', { class: 'prop' }, p))));
  box.append(section('Hooks', comp.hooks, h => el('li', {},
    el('span', { class: 'hook-name' }, h.name),
    h.detail ? el('span', { class: 'hook-detail' }, ' \\u2192 ' + h.detail) : null
  )));
  const map = byId(snap);
  box.append(section('Renders', comp.renders, r => {
    if (r.id && map.has(r.id)) {
      return el('li', {}, el('button', {
        class: 'link',
        onclick: () => { selectedId = r.id; render(); }
      }, r.name));
    }
    return el('li', {}, r.name + (r.external ? ' ' : ''), r.external ? el('span', { class: 'pkg' }, '(' + r.external + ')') : null);
  }));
}

function render() {
  renderTimeline();
  renderTree();
  renderDetail();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' && current > 0) { current--; render(); }
  if (e.key === 'ArrowRight' && current < SNAPSHOTS.length - 1) { current++; render(); }
});

if (SNAPSHOTS.length === 0) {
  document.querySelector('main').innerHTML =
    '<p style="padding:24px;color:var(--muted)">No snapshots yet. Run <code>hiarky snap</code> first.</p>';
} else {
  render();
}
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
