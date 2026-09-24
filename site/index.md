---
layout: home

hero:
  name: hiarky
  text: Review what your code declares
  tagline: Snapshot every component, route, procedure, model, migration and config in your project, then see how they change over time.
  image:
    light: /logo.svg
    dark: /logo-dark.svg
    alt: hiarky
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Philosophy
      link: /philosophy
    - theme: alt
      text: GitHub
      link: https://github.com/kosminog/hiarky

features:
  - title: Symbols, not lines
    details: Every module-scope declaration becomes a symbol with its signature, members, hooks and dependency edges, so a review reads "input +tier", not "43 lines changed".
  - title: Reviews ranked by impact
    details: "hiarky review main..HEAD ranks changes by how much they matter: public surface first, body-only edits last. Moves and renames are detected. Untested changes are flagged."
  - title: History you can browse
    details: hiarky view builds one self-contained HTML file with a timeline, the component tree and per-symbol detail. No server and no network needed.
  - title: Beyond JavaScript
    details: TypeScript and Python in depth. Prisma models, SQL migrations, package.json, compose files and .env names as symbols. A shallow scan covers Go, Rust, Java, Kotlin, C#, Swift, PHP and shell.
  - title: Framework-aware
    details: Next.js App Router pages and handlers become routes with the URL they serve. tRPC routers become procedures with their zod inputs.
  - title: Plain files in your repo
    details: Snapshots are human-readable YAML under .hiarky/, deduplicated by content and diffable in git. Past commits can be backfilled.
---

## Try it

```sh
npx hiarky snap
# change something, then
npx hiarky snap
npx hiarky review
```
