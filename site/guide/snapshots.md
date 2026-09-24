# What a snapshot captures

`hiarky snap` statically analyses your project and records every module-scope declaration as a
**symbol** with a stable id (`<file>#<name>`).

| Field | What it holds |
| --- | --- |
| `kind` | `component`, `function`, `class`, `type`, `const`, `route`, `procedure`, `model`, `migration`, `config` |
| `export` | `default`, `named` or `none` |
| `signature` | Normalised parameters and return type, for functions |
| `members` | Component props, interface and enum members, class members, object-literal keys |
| `hooks` | Every `useX(...)` call, with the bound variable name (`useState → count`) |
| `edges` | `renders` (JSX children), `calls` (project functions and imports), `extends`, `references` |
| `role` | Tags such as `client` / `server` (from `"use client"`), `class` for class components |
| `route` | The URL a page or handler serves: `/dashboard/company/:id`, `GET /api/health` |
| `bodyHash` | Hash of the declaration's source, so body-only edits are detected |

## Components

Function, arrow, `memo`/`forwardRef`-wrapped and class components are recognised. Props come
from destructured parameters and TypeScript annotations (inline literals plus same-file interfaces
and type aliases). Class components use `this.props.x` accesses.

## Imports

Imports are resolved so the graph connects in real projects: relative paths, `tsconfig.json`
path aliases (jsonc and `extends` chains included), workspace packages (`package.json#workspaces`
and `pnpm-workspace.yaml`) and barrel files. When a barrel re-exports a third-party package, the
edge records that package, not the local alias.

## Storage

Snapshots are stored as `.hiarky/snapshots/<timestamp>-<uuid>.snapshot`, in YAML so they are
readable and diffable in git. Metadata includes the timestamp, UUID, git commit, branch, dirty flag
and file, symbol and component counts.

A snapshot identical to the previous one is skipped. Snapshots written by earlier versions are
upgraded on read, so an existing history keeps working.
