# Casefile — contributor rules

Casefile is a local-first, single-user medical case ledger (Node 24, TypeScript,
Hono API, Vite + React 19 SPA, SQLCipher via Drizzle). Read PLAN.md for the data
model and phase acceptance criteria, DECISIONS.md for choices already made.

## Layout
- `src/server` API and jobs. `src/client` SPA. `src/shared` zod schemas, enums,
  date helpers, constants used by both. Never import server code from client.
- Routes: `src/server/routes/<feature>.ts` exports `<feature>Routes` (Hono
  sub-app); already mounted in `src/server/routes/index.ts` under
  `/api/<feature>`. Business logic goes in `src/server/services/<feature>.ts`.
- Client pages: `src/client/routes/<feature>.tsx` (TanStack file routes; the
  route tree is generated, do not edit `routeTree.gen.ts`). Full-page views use
  `<feature>_.$id.tsx` (underscore = not nested). Feature components live in
  `src/client/features/<feature>/`.
- Shared UI primitives in `src/client/ui` (DataTable, SplitView, Dialog, Tag,
  Field, Button, Kbd, DateText, PageHeader/Section/Meta, Toast). Use them.
- Styling: plain CSS classes from `src/client/styles/base.css` and tokens from
  `tokens.css`. No Tailwind, no CSS-in-JS, no inline colours. If you need a new
  class, add it to `src/client/styles/features.css` (create it if missing and
  import it from your route file) rather than editing base.css.

## Hard rules
- Do not change `src/server/db/schema.ts` or add migrations. Every table for
  every phase already exists. Use the `*_json` columns for extra structure. If
  something is truly missing, say so in your final report.
- Do not edit files owned by another feature. Shared files you may not edit:
  `routes/index.ts`, `nav.ts`, `schema.ts`, `base.css`, `tokens.css`,
  `main.tsx`, `__root.tsx`, `Shell.tsx`, `CommandPalette.tsx`, `shortcuts.tsx`,
  `ui/*`. Report needed changes instead.
- All AI calls go through `src/server/ai/client.ts` (`callStructured`,
  `callText`). Never construct an Anthropic client elsewhere. Never log keys.
- The database is only open while unlocked: always get it via `db()` from
  `src/server/db` at call time, never cache the handle at module scope.
- Every API input is validated with zod. Errors: throw `HttpError` from
  `src/server/util/errors.ts`; responses are JSON.
- Clinical dates are partial: store `x`, `x_precision`, `x_text` using
  `parsePartialDate` from `src/shared/dates.ts`. Display with `DateText`.
- Provenance: anything the model extracted must carry citations (document,
  page, quote). Citations are verified against `document_pages.text` and
  flagged, never dropped.
- The user's verdict outranks the model: never overwrite `status`,
  `verdictNote`, or user-edited fields of a `confirmed`/`disputed` fact.
- Soft delete (`deleted_at`) for user-facing entities; filter it everywhere.
- Full-text: when you insert/update/delete pages, facts, or entities, keep the
  `pages_fts`, `facts_fts`, `entities_fts` tables in sync (see
  `src/server/services/search.ts` helpers when present).

## UI brief (non-negotiable)
Dark is the default and must be excellent; light exists. Dense, calm,
keyboard-driven, editorial clinical-ledger feel. Split views: list left, detail
right. Dense tables with real sorting and filtering (DataTable). Every list
supports j/k, Enter, Esc. Register page actions in the command palette with
`useRegisterCommands` and key bindings with `useBindings` (group names: Lists,
Facts, Documents, Communications, Tasks, Findings, Ask, Page). Document the
keys in the page toolbar with `<Kbd>`.
Forbidden: gradients, glassmorphism, purple/indigo, rounded card grids with
icons, hero sections, stat tiles, emoji in UI text, centered marketing layouts,
illustrations, skeleton loaders, pure white, Tailwind palette colours. Loading
states are a single muted line of text. Buttons are text, not icons.
Selection in list routes lives in the URL search params (`?id=`) validated
with `validateSearch` so links and the command palette can deep-link.

## Verification
- `npm run typecheck` must pass for both server and client.
- `npm test` (vitest, tests in `tests/**/*.test.ts`) must pass. Add tests for
  your rules and schemas; use `openMemoryDatabase()` from `src/server/db` for
  DB tests (unencrypted in-memory, same migrations).
- To run the API during development on a private port and data dir:
  `CASEFILE_PORT=48xx CASEFILE_DATA_DIR=.tmp/agent-x npx tsx src/server/index.ts`
  then `POST /api/auth/setup {passphrase}` and reuse the cookie. Do not use the
  shared default port 4810 or the default `data/` directory. Do not use the
  browser tools; verify with typecheck, tests, build (`npx vite build`), and curl.
- Report what you built, what you verified, and anything you could not do.

## Data safety (absolute)
The user keeps their only working copies of real medical records in this tree.
- Never delete, move, rename, truncate, or overwrite anything under `Files/`,
  `data/`, `backups/`, or any `*.bak*` / `*.set-aside*` folder. Never run
  `rm -rf`, `git clean`, `git checkout -- <path>`, `git reset --hard`,
  `Remove-Item -Recurse`, or `Compress-Archive -Force` against paths outside
  your own `.tmp/<agent-dir>`.
- If a file or folder must make way for a change, copy it first into a dated
  set-aside folder (`set-aside/YYYY-MM-DD-<reason>/`) at the project root, keep
  the original untouched, and say so in your report. "Set aside" is allowed;
  "gone" is not.
- In the app, user-facing delete is always a soft delete (`deleted_at`) and the
  encrypted original stays in the file store. Only an explicit, separate purge
  action (confirm dialog naming the file) may call `deleteFile`, and it must
  first copy the plaintext original into `data/trash/<date>/` for 30 days.
- Database changes are additive. Never drop or rename a column or table; never
  write a migration that rewrites rows. Never use the SQLite backup API or
  `VACUUM INTO` (they can write plaintext copies).
- Restore never replaces data in place: it renames the existing `data/` to a
  dated `.bak` folder first (see scripts/restore.ts).
- When in doubt, stop and report instead of deleting.
