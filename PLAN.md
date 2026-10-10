# Casefile — Plan

Casefile is a local-first, single-user medical case-management tool. It is the
single source of truth for one complex case: where every document lives, what
it says, who has spoken to whom and when, what is missing, what is due, and
what the documents reveal when read together.

This file holds the data model, the phase breakdown, and the acceptance
criteria for each phase. Decisions made without the user are in DECISIONS.md.
How to run, back up, and restore is in README.md.

## 1. Stack (verified on this machine, 2026-10-04)

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 24, TypeScript, ESM | Already installed; no second runtime needed |
| API server | Hono on `@hono/node-server`, bound to 127.0.0.1 | Small, typed, no ceremony |
| UI | Vite + React 19, TanStack Router (file routes), TanStack Query, TanStack Table, cmdk | Dense tables, type-safe URLs, command palette |
| Database | SQLite via `better-sqlite3-multiple-ciphers` (SQLCipher) + Drizzle ORM + drizzle-kit migrations | Encryption at rest with prebuilt Windows binaries (tested) |
| File store | Local directory, each original encrypted with AES-256-GCM | Originals are as sensitive as the DB |
| PDF text + render | `mupdf` (WASM) | Page-accurate text with boxes and page rasterisation, no native deps |
| OCR | `tesseract.js` with `@tesseract.js-data/eng` bundled | Runs fully offline (tested; no CDN fetch) |
| DOCX / CSV / DICOM | `mammoth` / `papaparse` / `dicom-parser` | Conservative, pure JS |
| AI | `@anthropic-ai/sdk`, structured outputs via `messages.parse` + zod | Strict JSON schema extraction; every call logged |
| PDF export | Headless Edge/Chrome via `puppeteer-core` (already on the PC) + `pdf-lib` to append originals | Print CSS becomes the PDF; no bundled browser download |
| Tests | vitest | Extraction schema, cross-ref rules, export |
| Styling | Hand-written CSS with design tokens; fonts bundled via `@fontsource` | No Tailwind palette, no runtime font fetch |

Outbound network: only `api.anthropic.com`, only when an AI action is
triggered, every call recorded in the `ai_calls` table with purpose, model,
token counts, estimated cost, and the document ids involved.

## 2. Data model

All tables live in one SQLCipher database (`data/casefile.db`). Ids are UUIDs.
Dates are ISO-8601 strings with a separate `date_precision`
(`day | month | year | unknown`) and the original `date_text` as written,
because the records disagree and partial dates are common.

### Core
- **documents** — one row per uploaded file. Original bytes live in the file
  store under `storage_key`. Fields: title, filename, mime, kind
  (pdf, image, docx, text, csv, json, dicom, audio_transcript, other),
  category (clinical_note, lab_report, imaging_report, portal_message,
  call_transcript, summary, dossier, letter, other), institution (person id),
  document_date (+precision, +text), page_count, sha256, text_status
  (pending, extracted, ocr_needed, ocr_done, failed), extraction_status,
  extraction_schema_version, metadata_json (DICOM tags etc.), tags, notes.
- **document_pages** — page_number, text, `ocr` flag, confidence, width,
  height. This is the page map every citation points into.
- **facts** — atomic statements. type (lab_result, diagnosis, medication,
  procedure, symptom, clinician_statement, imaging_result, vital,
  allergy_intolerance, recommendation, referral, record_reference,
  follow_up, event), statement, date (+precision, +text), date_end,
  attributes_json (typed per fact type, validated by zod), confidence,
  status (unverified, confirmed, disputed, superseded), superseded_by_id,
  verdict_note, origin (ai, manual, import), extraction_run_id, dedup_key.
- **citations** — the provenance link. Points at document_id + page_number,
  with the quoted passage and char offsets inside the text of that page, and
  a `verified` flag set only when the quote was found in the page text. A
  citation belongs to exactly one of fact, finding, communication, or
  ask_message.
- **fact_merges** — proposed duplicate pairs with similarity and reason;
  status pending, accepted, rejected. Nothing merges silently.
- **extraction_runs** — one per (document, schema version, model) pass.

### People and contact
- **people** — clinicians, clinics, institutions, advocates, family, chief of
  staff. kind, role, specialty, institution_id (self reference), phone,
  email, portal, fax, address, notes. Observed response latency is computed
  from communications.
- **communications** — every contact event. occurred_at (+precision),
  direction, channel (portal, call, email, visit, fax, letter, text, other),
  subject, summary, outcome, follow_up_promised, follow_up_due,
  follow_up_done_at, document_id (transcript or message text).
- **communication_participants** — person_id + role (from, to, cc, present).
- **communication_topics** — free tags so "who spoke to whom about what" is
  one query.

### Records inventory
- **records_inventory** — what exists or should exist. title, record_type
  (clinical_note, lab, imaging_report, imaging_images, dicom, pathology,
  operative_report, discharge_summary, portal_thread, billing, other),
  institution_id, system (e.g. MyChart), format (report, images, dicom, raw,
  unknown), held, held_form, document_id, status (unknown, expected,
  requested, received, not_held, denied), requested_at, received_at,
  source_fact_id (the reference that implied it), notes. A **gap** is an
  inventory row in state expected/requested/not_held/denied, or a
  `record_reference` fact that matches no held inventory row.

### Encounters, medications, symptoms, labs, imaging
- **encounters** — occurred_at (+precision), kind (visit, telehealth,
  procedure, admission, test, other), clinician_id, institution_id, title,
  prep_notes, questions_json, outcomes, status (upcoming, completed,
  cancelled).
- **medications** — name, generic_name, drug_class, dose, unit, route,
  frequency, start/stop (+precision), status (active, stopped, prn, planned,
  unknown), prescriber_id, indication, reason_stopped, notes, source_fact_id.
- **medication_events** — start, stop, dose_change, hold, resume, reaction,
  with date and detail. These overlay the symptom charts.
- **intolerances** — substance, kind (allergy, intolerance, hard_stop,
  caution), reaction, severity, `hard_stop` flag. Hard stops render on every
  medication screen and on the emergency card.
- **symptom_definitions** — the configurable 0–10 symptom set.
- **symptom_entries** — date, symptom_id, score, note.
- **daily_log** — date, sleep_hours, sleep_quality, notes.
- **lab_results** — analyte, value_num/value_text, unit, ref_low, ref_high,
  flag, specimen (serum, csf, urine, other), collected_at (+precision),
  lab_name, document_id, fact_id.
- **imaging_studies** — modality, body_part, performed_at (+precision),
  institution_id, impression, findings, document_id, fact_id, has_images,
  dicom_document_ids_json.

### Work
- **tasks** — title, detail, owner (me, chief_of_staff, advocate, person),
  owner_person_id, due_at, remind_at, status, priority, source_type +
  source_id (fact, finding, communication, document, encounter, manual).
- **findings** — category (discrepancy, missing_record, trend, overlooked,
  correlation), title, why_it_matters, detail, severity, status (new,
  confirmed, dismissed, resolved, disputed), verdict_note, run_id.
  Evidence is in **finding_evidence** (fact_id / document_id / citation_id /
  note) so every finding is clickable down to a passage.
- **crossref_runs** — scope, model, status, counts.
- **ask_sessions / ask_messages** — chat over the corpus, with citations.
- **export_packets** — what was exported, when, and the resulting file.

### System
- **settings** — key/value JSON (models, idle lock, theme defaults, API key
  encrypted inside the DB).
- **ai_calls** — the outbound-call log: purpose, model, document ids,
  input/output/cache tokens, estimated USD, duration, status, error.
- **jobs** — the persistent queue: type, payload, status, progress, attempts,
  error. Survives restarts.

### Timeline
Not a table. A union query over facts, communications, encounters,
medication_events, lab_results, imaging_studies, symptom/daily entries,
tasks, and findings, each tagged with its source so the UI can filter by
kind and zoom from years to a day.

## 3. Phases

### Phase 0 — Plan (this file)
Done when PLAN.md, DECISIONS.md, README.md exist and the toolchain is verified.

### Phase 1 — MVP (usable with real documents)
Scope: project scaffold; passphrase lock with encrypted DB and file store;
document upload (PDF, image, DOCX, TXT, MD, CSV, JSON, transcript text,
DICOM metadata) with text extraction, OCR for scanned pages, and a page map;
AI fact extraction with citations, confidence, dedup proposals; verification
with one-key verdicts; People; Communications; Records inventory with gap
detection; Timeline; command palette; keyboard shortcuts; the design system
applied end to end; one-command run and backup; migrations and seed.

Acceptance criteria:
1. `npm run setup` then `npm run dev` starts the app on http://127.0.0.1:4810
   with no other services. First run asks to create a passphrase; later runs
   ask to unlock. Wrong passphrase fails. Idle timeout re-locks.
2. `data/casefile.db` is not readable without the passphrase (sqlite3 reports
   "file is not a database"). Files under `data/files/` are not the original
   bytes.
3. Dropping a scanned PDF produces page text (OCR) and a per-page confidence;
   a text PDF skips OCR; DOCX/TXT/MD/CSV/JSON produce text; a DICOM file
   stores its metadata.
4. "Extract facts" on a document creates facts whose citations resolve to a
   page and a highlighted passage in the document viewer. A citation whose
   quote cannot be found in the page text is marked unverified and shown as
   such.
5. In the facts list, `c` confirms, `d` disputes, `u` resets, `s` supersedes
   the selected fact, and the verdict persists and outranks the model
   (re-running extraction never changes a confirmed/disputed fact).
6. Duplicate-looking facts show up as merge proposals; nothing merges until
   accepted.
7. People and Communications support "who has spoken to whom about what":
   a person view lists every communication with that person, by topic, with
   direction and promised follow-ups and their due dates.
8. Records inventory lists held/expected/requested records and a Gaps view
   lists records implied by documents (e.g. a note references a PET scan
   with no PET report on file).
9. Timeline shows all entities in one chronology with kind filters and a
   zoom from years to a day; partial dates display at their precision.
10. Ctrl+K reaches every entity and action; `?` shows the shortcut sheet;
    dark is the default theme, dim and light exist, large-type toggle works,
    and no pure white is used anywhere.
11. Every AI call appears in the AI log with model and token counts; the AI
    off switch blocks all outbound calls.
12. `npm run backup` writes `backups/casefile-<date>.zip` with DB + files;
    `npm run restore <zip>` brings it back.
13. `npm test` passes: extraction schema validation, citation verification,
    gap rules, dedup keys.

### Phase 2 — Clinical ledgers and printables
Medications with history, dose changes, reactions; intolerances with hard
stops on every medication screen; symptoms and daily log with charts
overlaying medication/treatment events; labs and imaging trend views with
reference ranges; tasks and reminders with iCal export; emergency card and
daily-plan printables.

Acceptance: hard stops visible on every medication screen and the printed
emergency card; a lab trend shows out-of-range values against reference
range across documents; symptom chart overlays medication events; tasks
export to `.ics`; printables are legible in print preview at Letter size.

### Phase 3 — Cross-reference, Ask the case, Packet export
Deterministic rules plus an AI pass produce Findings in the five categories
with evidence and "why this matters"; Ask the case answers with citations and
refuses without a source, supports message drafts and pre-visit briefings;
Packet export produces a PDF with cover summary, records index, emergency
card, selected facts/findings/timeline, and appended originals.

Acceptance: each finding links to evidence facts and passages; no finding is
worded as a diagnosis; an unanswerable question returns a refusal with the
closest sources; the exported PDF opens in Edge and contains the index and
emergency card; token usage per run is displayed.

### Phase 4 — DICOM viewer, calendar import, polish
Basic DICOM image viewer (window/level, scroll through series), ICS/CSV
calendar import into encounters and daily log, performance passes on large
documents, shortcut and print polish.

## 4. Conventions (for every contributor, human or agent)
- Server code in `src/server`, client in `src/client`, shared zod schemas and
  types in `src/shared`. Never import server code from the client.
- Every new table gets a drizzle migration (`npm run db:generate`).
- Every API route validates input with zod and returns JSON; errors are
  `{ error: string }` with a correct status.
- Every AI call goes through `src/server/ai/client.ts` so it is logged.
- Every UI list is a dense table or ledger with sorting and filtering, lives
  in a split view with the detail on the right, and has a keyboard path.
- No gradients, glass, purple, icon-card grids, hero sections, stat tiles,
  emoji in UI text, skeleton loaders. Colors come from `tokens.css` only.

## 5. Status (2026-10-05)

Built and verified live against the Anthropic API with the user's key:

- Phase 1 (documents, OCR, facts with verified citations and verdicts, people,
  communications, records and gaps, timeline, design system): done; all
  acceptance criteria met except item 11's "AI off switch" which is verified
  by the blocked-call path only.
- Phase 2 (medications and emergency card, symptoms with charts, labs and
  imaging trends, tasks and daily plan): done.
- Phase 3 (cross-reference findings, Ask the case, packet export): done. The
  consult became the "master clinician" with a depth slider (Quick, Standard,
  Deep, Master clinician on Fable 5.1), read-only tools (search, facts, lab
  series, pages, timeline, communications, documents) and charts. Measured on
  the real documents: Quick answers in 15 to 20 seconds with 10 to 25
  citations; Master clinician took 8 minutes, 4 turns, 13 tool calls, 3
  charts, 187 citations, about 6 dollars.
- Added after the brief, at the user's request: the Inbox with model triage
  and one-key filing; a full Search page; source tiers (primary, patient,
  compilation, external) classified on every upload with auto-titling; per-fact
  objectivity and asserted-by with the patient-precedence rule applied in the
  consult and findings layers only; a generated document brief; labs and
  imaging organised by specimen, panel and document; multiple users with their
  own passphrases and roles (owner, editor, viewer), audit log, first-run
  setup, optional LAN access.
- Phase 4 (DICOM viewer for uncompressed series with window/level, calendar
  and CSV import with dry run, folder import that copies, trash with restore
  and purge-after-copy, virtualised long tables): done.
- Review: a 32-reviewer sweep (229 findings, 124 confirmed and fixed), a
  follow-up round (66 cross-area items), and a final two-reviewer resweep (13
  fixed). 772 tests pass; typecheck and build are clean.

Live lessons recorded in DECISIONS.md: structured-output schemas must stay
flat (24 optional, 16 union parameters), extraction runs at low effort with a
64k output ceiling, long structured calls stream, cache breakpoints are 1h.
