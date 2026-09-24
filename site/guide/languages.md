# Languages and files

## JavaScript and TypeScript

JS, TS, JSX and TSX are parsed with Babel and get the full treatment described in
[What a snapshot captures](./snapshots): signatures, members, hooks and a resolved call graph.

### Framework shapes

- **Next.js App Router.** `app/**/page.tsx` and `route.ts` become `route` symbols carrying the URL
  they serve. Route groups `(shell)` and parallel slots `@modal` are dropped, `[id]` becomes
  `:id`, and catch-alls become `*slug`. Handlers exported under a method alias
  (`export { handler as GET }`) are recorded once per method.
- **tRPC.** `createTRPCRouter({ … })` yields one `procedure` symbol per key, tagged
  `query`/`mutation` and `protected`/`public`, with its zod input fields as members. Schemas
  declared elsewhere are followed through imports, `.extend`, `.merge`, `.pick`, `.omit` and shape
  spreads. Mounted sub-routers become `references` edges.

## Python

Python files are analysed with the interpreter's own `ast` module:

- module-level functions, with annotations **and defaults** in their signatures
- classes, with members, base classes and pydantic-style typed fields tagged `schema`
- constants, and calls between project modules (relative imports included)

Decorators become roles (`lru_cache`, `async`). Route decorators become `route` symbols: FastAPI's
`@app.post("/classify")` reads as `POST /classify`, and Flask's
`@app.route("/items", methods=["POST"])` works too. Visibility follows `__all__` when defined,
otherwise the leading-underscore rule.

One interpreter run covers the whole scan. A file that will not parse still gets a hash-only symbol
and an entry in the snapshot's `errors`.

## Config, schema and migrations

| File | Symbols |
| --- | --- |
| `schema.prisma` | One per model (fields, `@@index`/`@@unique`, relations as `references` edges), enum and datasource/generator block |
| `prisma/migrations/**/*.sql` | One per migration, with a one-line summary of each statement |
| `package.json` | `scripts`, `dependencies`, `devDependencies`. A bump reads as `-react@^18 +react@^19` |
| `.env.example` | Variable **names only**, never values |
| `compose.yaml` | One per service, with its settings |
| `pyproject.toml`, `Cargo.toml` | One per section, plus one per dependency list |

## Tests

Test files are scanned like any other source. Each top-level `describe` (or `suite`/`context`)
becomes a `test` symbol whose members are its cases. A suite's edges record what it exercises, with
the runner's own API filtered out. That is what lets [`review`](./review#test-coverage) say whether
a changed symbol had a test change.

## Everything else

Go, Rust, Java, Kotlin, C#, Swift, PHP and shell get a shallow declaration scan: top-level
functions, methods (named after their receiver, `Server.Start`), types with their fields or
methods, and constants, using each language's own visibility rule. A Rust `impl` block merges into
the type it implements.

The shallow scan records no call graph and does not go deeper than one level of nesting. It shows
*what changed where*, not the depth TypeScript or Python get.
