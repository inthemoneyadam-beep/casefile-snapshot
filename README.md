# CaseFile

A local-first case ledger for one complex medical case: where every document
lives, what it says, who has spoken to whom and when, what is missing, what is
due, and what the documents reveal when read together.

Everything stays on this PC. The database is SQLCipher-encrypted and every
uploaded file is encrypted with a key derived from your passphrase. The only
outbound network call is to the Anthropic API when you start an AI action
(reading a document, filing an inbox item, a consult question, a
cross-reference pass), and every such call is recorded in the AI log with its
model, token counts and estimated cost.

## Requirements
- Windows 10/11 with Node.js 22 or newer (24 tested). Nothing else to install.
- Microsoft Edge or Google Chrome (already on Windows 11) for PDF packet export.
- An Anthropic API key for the AI features (console.anthropic.com). Without a
  key everything else still works; AI actions fail cleanly and say why.

## Start here (no terminal needed)
Double-click **Start CaseFile.cmd** in this folder (a Windows launcher; not part of
this public snapshot). A black window opens;
leave it open while you use the app and close it to stop. After a few seconds
your browser opens http://127.0.0.1:4810. Bookmark that address.

The first time, you get the setup screen: your name, a passphrase (twice),
your chief of staff (pre-filled "Chief of staff") with an optional passphrase of
their own, your Anthropic API key (optional; it can be added later in Settings), and
a box to import the documents in the `Files/` folder next to the app. They are
copied in; the folder itself is never changed. The passphrase encrypts the
database and every file. There is no recovery if it is lost, so write it down
somewhere safe. Each person with a passphrase opens the same case; the name on
the lock screen decides whose session it is and what they may change.

To make a backup, double-click **Back up CaseFile.cmd** (also not in this snapshot) with the app
closed or locked, or use Settings, Back up now, while it is open.

## For developers
```bash
npm run setup   # install dependencies, write config.json, create folders
npm run dev     # API on 4810 plus Vite with hot reload on 4811
npm start       # build the client and serve everything on 4810
```

## What is where
Sections as the menu names them (`src/client/app/nav.ts`); `g` and one more key opens each one.

| Section | What it holds |
|---|---|
| Home | Due and overdue to-dos, promised follow-ups, upcoming appointments, what waits for your answer, recent documents, and a place to add documents |
| Ask the clinician | The consult. A slider picks the depth per question: Quick, Standard, Deep, Master clinician |
| Search everything | Full-text search over documents, pages, details, people, calls and messages, records, ledgers |
| Documents | Every file with its text, page map, generated brief, source tier and the details read from it. A file dropped anywhere in the app is read, named and filed here |
| Lab results, Scans and imaging | Results grouped by specimen and panel (CSF separate from serum), trends with reference ranges, by-document view |
| Medications, Symptom diary | History with events and hard stops; the daily 0 to 10 log with charts and medication overlays |
| Appointments, Calls and messages, People and places | Who, how to reach them, who has spoken to whom about what, what was promised and when |
| Timeline | Everything in one chronology, with a density strip and year, month, day zoom |
| Reconciliation | Where the records disagree; upload the record that settles it, and anything wrong is marked inaccurate |
| Check before filing | Uploads you chose to look at before they are filed, with Claude's suggestion; files added anywhere else go straight to Documents |
| To-do list | Owner, due date, source link, reminders, calendar export |
| Records checklist | What exists or should exist, where it lives, whether we hold it, request status, and the Gaps view |
| What Claude noticed | What the cross-reference rules and the deep pass noticed, with evidence, never worded as a diagnosis |
| Details from documents | Atomic statements with citations and your answer (`c` accurate, `f` only in a summary, `d` wrong, `u` back to automatic, `s` replaced by a newer one, `o` you say otherwise, `e` edit, `n` add by hand; `a`/`b`/`r` decide possible duplicates) |
| Make a packet | A clean PDF for a second opinion: cover, records index, emergency card, details, findings, originals |
| Import calendar or spreadsheet | Appointments from a calendar file, or labs and calls from a spreadsheet |
| Settings | Models and effort, lock timeout, appearance, patient details, people with access, backup |
| How CaseFile works, AI usage log | The words and buttons in plain terms; every request sent to Claude and what it cost |

Printables: Medications has the emergency card (`p`), the To-do list has the daily plan.

## The consult
`Ctrl+.` opens the consult beside any screen; `g a` opens the full page. The
slider sets who answers and how hard they think:

| Preset | Model | Reads | Typical |
|---|---|---|---|
| Quick | Sonnet 5.5, low effort | top matching pages and facts | seconds, cents |
| Standard | Sonnet 5.5, high effort | the whole ledger plus matches | under a minute |
| Deep | Opus 5.5, extra-high effort | ledger plus many pages | minutes |
| Master clinician | Fable 5.1, maximum effort | the whole case as far as it fits | 5 to 15 minutes, several dollars |

Every statement in an answer carries a citation you can open; an answer with
no source says "Not in the case file." The consult can search the case, pull a
lab series, read pages, and draw charts from the stored rows. Your own
statements take precedence over clinicians' assessments (effect, tolerance,
impressions); measured values from clinical documents are never overridden.

## Source tiers
Each document is classified on arrival: primary (an actual clinical document),
patient (written by you or your chief of staff), compilation (a summary or
analysis assembled from other records), external. Facts inherit who asserted
them. The record itself never hides anything; the hierarchy only applies when
the consult and the findings engine reason over it.

## Back up and restore
```bash
npm run backup
```
Writes `backups/casefile-YYYYMMDD-HHMMSS.zip` with the encrypted database, the
keyring, and the encrypted file store. A name that already exists gets `-2`,
`-3`, ...; the zip is written as `.partial` and renamed only when complete, so
an earlier backup is never overwritten. Settings has a "Back up now" button
that does the same while the app is running, and is the consistent way while
the case is unlocked (the command then copies without a checkpoint and warns).

```bash
npm run restore -- backups/casefile-20261005-020000.zip
```
Stop the app first. Use `--force` to replace an existing `data/`; the old one
is renamed to `data.bak-<timestamp>`, never deleted. Unlock with the passphrase
in use when the backup was made.

## Data safety
Nothing under `Files/`, `data/` or `backups/` is ever deleted or overwritten by
the app. Deleting a document is a soft delete that keeps the encrypted
original; a separate purge action copies the original to `data/trash/<date>/`
before removing anything and asks you to type the title to confirm. Every
agent that worked on this code was bound by the same rule (see CLAUDE.md).

## Keyboard
`Ctrl+K` command palette, `?` the shortcut sheet, `g` then a letter to jump to
a section, `j`/`k` to move in any list, `Enter` to open, `Esc` to clear.
`v t` cycles dark, dim, light; `v b` toggles large type; `v r` reduced
contrast. `Ctrl+.` the consult dock. `Ctrl+Shift+X` locks.

## Other commands
| Command | What |
|---|---|
| `npm run typecheck` | TypeScript for server and client |
| `npm test` | vitest: schemas, citation matching, gap rules, precedence, ICS, export |
| `npm run db:generate` | Generate a migration after editing `src/server/db/schema.ts` |
| `npm run seed` | Load a small synthetic case for a look around. Run it against a scratch folder: `CASEFILE_DATA_DIR=./data-demo npm run seed -- --passphrase "demo passphrase"`. It refuses a case that already holds records unless `--force`, and never writes into the default `data/` once it holds records |

## Configuration
`config.json`: `port`, `dataDir`, `backupsDir`. Environment overrides:
`CASEFILE_PORT`, `CASEFILE_DATA_DIR`, `CASEFILE_BACKUPS_DIR`, `ANTHROPIC_API_KEY`
(takes precedence over the key stored in Settings).

See PLAN.md (data model, phases, acceptance criteria). DECISIONS.md (decisions
taken without the user, with reversal notes) is not part of this public snapshot.
