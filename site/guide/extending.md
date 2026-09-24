# Adding a language

Extractors are plugins. Each is one object with:

- `globs`: the files it claims
- `matches(file)`: whether it handles a given file
- `analyze(abs, rel)`: returns symbols, imports and re-exports

Everything downstream (linking, snapshotting, diffing, reviewing, the viewer) works on that shape.
A new language is one new file in
[`src/extractors/`](https://github.com/kosminog/hiarky/tree/main/src/extractors), registered in
`src/extractors/index.ts`.

An extractor with a fixed cost per call can also implement `analyzeMany(files)`. A scan then calls
it once for all its files instead of once per file. That is how the Python extractor runs a single
interpreter for the whole project.

## Development setup

```sh
git clone https://github.com/kosminog/hiarky.git
cd hiarky
npm install
npm run build
npm link   # makes `hiarky` available globally from this checkout
npm test
```

`npm run dev` rebuilds on change and `npm run typecheck` type-checks without emitting.

## Roadmap

- A tree-sitter backend to deepen the shallow-scanned languages (call graphs, nested declarations)
- Per-symbol history and compare-any-two-snapshots in the viewer
