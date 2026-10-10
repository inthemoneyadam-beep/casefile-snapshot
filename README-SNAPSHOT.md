# About this snapshot

This is a read-only, code-only snapshot of CaseFile, a private, local-first
ledger for one patient's medical case. It is shared so that another assistant
can read how the app works: its data model, its rules, its prompts and its
screens.

What was removed before publishing:
- all personal data and records (no documents, databases, backups, keys or
  exports);
- the test suite (`tests/`), the decision log (`DECISIONS.md`), agent notes,
  editor settings, the Windows launchers (`*.cmd`), `package-lock.json` and the
  deployment guide for the live server (replaced by a generic `docs/DEPLOY.md`);
- names in comments, prompts and UI words, generalised to "the patient", "the
  user", "you" or "the chief of staff"; examples that may have come from real
  records (values, dates, document titles, places, medicines, symptoms) were
  replaced with invented ones that make the same point.

It is a single commit with no history. It is not meant to be built or run as
is (dependencies are not installed, the lockfile and tests are absent), and it
is not maintained here.

## Layout
| Path | What |
|---|---|
| `BRIEFING.md` | Plain-words tour of the app: features, rules, pages, safety |
| `PLAN.md` | Data model, phases and acceptance criteria |
| `CLAUDE.md` | The rules every contributor (human or agent) follows |
| `README.md` | How the app is started, backed up and restored |
| `docs/DESIGN.md` | The design system: tokens, type, layout, components |
| `docs/DEPLOY.md` | Hosted mode in general terms (variables by name only) |
| `src/shared/` | Code used by both sides: zod schemas, enums, partial dates, lab value parsing, analyte names, constants and the pure rules |
| `src/server/` | Hono API (`routes/`), business logic (`services/`), AI calls and prompts (`ai/`), ingestion of PDFs, OCR, Epic exports and DICOM (`ingest/`), encryption (`crypto/`), the database schema and migrations (`db/`), packet export (`export/`), the job queue (`jobs/`) |
| `src/client/` | Vite + React 19 SPA: TanStack file routes (`routes/`), feature components (`features/<feature>/`), shared UI primitives (`ui/`), API hooks (`api/`), app shell and shortcuts (`app/`), CSS tokens and classes (`styles/`) |
| `scripts/` | Backup, restore, seed (an invented demo case), setup, deploy-ignore proof, container smoke test |
| `Dockerfile`, `railway.json`, `.dockerignore`, `.railwayignore` | The container build for hosted mode |

## Where to start reading
1. `BRIEFING.md` for what the app does and why.
2. `PLAN.md` for the data model, then `src/server/db/schema.ts`.
3. `CLAUDE.md` for the hard rules (provenance, the user's verdict outranks the
   model, soft delete, additive migrations, data safety).
4. `src/shared/` for the pure rules: `labvalues.ts` and `analytes.ts` (lab
   values as printed), `dates.ts` (partial dates), `reconcile.ts`, `notes.ts`,
   `patient-identity.ts`, `labcompute.ts`, `care-team.ts`, `schemas/`.
5. `src/server/services/` for the behaviour behind each page (documents,
   facts, labs, reconcile, crossref-rules, ask and ask-context, filing,
   lab-check, med-timeline, self-check, care-team), and `src/server/ai/` for
   the prompts and the single AI client.
6. `src/client/routes/` for the screens, with their parts in
   `src/client/features/`.

Nothing in the code describes the owner. The lab catalogue and the examples
are generic or invented, and `scripts/seed.ts` is a fully synthetic case.
