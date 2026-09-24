# The viewer

```sh
hiarky view
```

`hiarky view` embeds every snapshot into a single `.hiarky/view.html`. It needs no server and no
network, so you can open it offline or send it to someone.

- **Timeline.** A sidebar lists every snapshot with its commit and diff badges (`+added`,
  `−removed`, `~changed` against the previous snapshot).
- **Component tree.** Collapsible, with added and changed markers. Recursive renders and external
  components are handled.
- **Other symbols.** Every non-component symbol, grouped by file, with the same change markers.
- **Detail panel.** File, signature, members, hooks, and clickable `renders` and `calls` targets.
- **Keyboard.** Use ← and → to move between snapshots.
