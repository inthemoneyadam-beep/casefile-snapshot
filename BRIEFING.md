# CaseFile: project briefing

A plain-words tour of what the app does and why, written by the Claude Code
session that builds it. This public copy has every personal detail removed:
the owner, the people around the case, places, records, values from records,
dates of care and deployment details. Where a number or name appears below it
is an invented example.

## What it is and who uses it
- CaseFile is a private ledger for one person's own complex medical case:
  every document, what each one says, who said what to whom and when, what is
  missing, what is due, and what the documents show when read together.
- The loop: the patient adds documents. Claude reads, names, sorts and files
  them. Every detail is checked automatically against the clinical records.
  The patient only steps in where documents disagree and no clinical record
  settles it.
- "Ask the clinician" is a chat over the whole case. Every statement in an
  answer cites the page it came from.
- On screen the app says "Claude", "the clinician" and "details" (the code
  calls details "facts").
- The patient is the owner. A chief of staff is the default second person.
  Each person has their own passphrase to the same case.
- Roles: Owner (everything). Editor (everything except managing people,
  purging, security settings, the API key, backup downloads and the audit
  log). Viewer (reads everything; can add calls and messages, to-dos and
  symptom days).
- It describes what the records say. It never diagnoses, recommends treatment
  or claims one thing caused another.
- Under the hood: Node 24, React and an encrypted SQLite database (SQLCipher).

## Where it runs
- Locally on one computer (127.0.0.1, optionally the home network), or hosted:
  one private server with an encrypted database on its own disk (the code is
  prepared for Railway; see docs/DEPLOY.md).
- Hosted mode:
  - needs a one-time setup code to set up or restore, so a stranger who finds
    the address cannot;
  - can take a case from an encrypted backup zip uploaded in 16 MB pieces that
    resume if the upload stops (only onto an empty server);
  - shows no names on the lock screen, and after 5 wrong passphrases from one
    place (or 30 from anywhere) makes the person wait 15 minutes;
  - has no "Import a folder"; files are dropped or chosen instead. A drop of
    files must upload within 5 minutes.
- The server itself is the lock: every update, restart or crash starts locked.
  Readings only run while unlocked; ones that stopped part-way carry on by
  themselves after unlock, within the cost limit.
- While unlocked, the decrypted records sit in the server's memory (an
  accepted trade-off). At rest everything stays encrypted.
- The app was designed keyboard-first for a computer screen.

## How a document becomes facts
1. Upload. A file dropped anywhere goes to Documents. Up to 2 GB. An exact byte
   copy is refused and the existing document is shown. The original is
   encrypted into the file store.
2. Text. PDF text comes out with its layout. A page with under 30 characters
   of text is read by OCR, offline; a failed OCR page never fails the
   document. Images are OCR'd; Word, CSV and text files become pseudo-pages.
3. Parts. Long documents are cut into "parts": an encounter, a section of
   one, or a block of pages.
4. Upload record. The stored file and page count are checked. The banner ends
   with one sentence, such as "All N pages read; every page accounted for", or
   says what is missing.
5. Likely copies. A near-identical document (90% or more of its text, nearly
   identical numbers) is flagged "likely copy". Different dates, values, or
   words like "amended" mean a different document. Only the newer one is
   flagged. Nothing is deleted.
6. Sorting. Claude reads the first 8 pages with text and proposes a title,
   kind, date, source tier, author role, a summary, 3 to 7 key points with
   quotes, and the people mentioned. It only fills gaps; a title the user set
   is never replaced.
7. Reading. Claude reads every part and pulls out details with citations, one
   document at a time.
8. After each reading: the patient-precedence rule, reconciliation, the lab
   typo rule, a fresh document brief, and automatic filing of medications and
   allergies (only from clinical records and the patient's own notes, never
   summaries).
9. Then the lab check (no AI) and the built-in finding rules (no AI) run.
- Details come in 14 types: lab result, diagnosis, medication, procedure,
  symptom, clinician statement, imaging result, vital, allergy or intolerance,
  recommendation, referral, record reference, follow-up, event. Each records
  whose voice it is (patient, clinician, compiler, unknown) and whether it is
  objective (measured) or subjective (an opinion or effect).
- Claude's reading rules: only what the document states, no inference, no
  diagnosis. One small detail per entry ("better a hundred small facts than a
  summary"). Dates exactly as written. Sending or reading a message is not a
  detail; what it says is. Every record mentioned is noted, which is how
  missing records are found.

## Citations, trust and the user's verdict
- Every detail needs 1 to 4 citations: a page and a quote of 5 to 300
  characters, copied exactly, typos and OCR noise included.
- Each quote is checked against the stored page text: exact, then with
  spacing, case and punctuation folded, then a close match (78% or more).
- Numbers must agree, in order. A quote with a different number is never
  verified.
- An unverifiable citation is kept and flagged, never dropped. Citations are
  re-checked whenever a page's text changes.
- Source tiers, set when a document is sorted:
  - Clinical record: the truth for measurements.
  - The patient's own notes (the patient or the chief of staff): outrank a
    clinician on how things felt.
  - Summary (compilation): summaries, dossiers, AI analyses. Never outranks a
    clinical record.
  - Outside letter: insurers, employers, advocates.
  - Not sorted yet.
- Trust follows the passage: the patient's own message inside a clinical
  record counts as the patient's. A passage is never trusted more than its
  document.
- Measurement-like details (labs, scans, vitals, procedures, events) get an
  automatic label:
  - Verified: from a clinical record.
  - Accurate: matches a verified detail, or the user said it is right.
  - Not backed yet: nothing to compare with ("Not compared" gives the reason).
  - Inaccurate: contradicts the record (a different value on the same day, or
    a nearby date that differs: labs within 3 days, procedures, scans and
    events within 7, vitals same day), or the user said it is wrong.
  - Needs a source: mentions disagree and no record settles it, or two records
    disagree.
  - Replaced.
- The patient-precedence rule: measured facts from clinical records are
  ground truth. On subjective matters (effect, tolerance, how certain a
  diagnosis is, how a symptom went, whether a record is missing) the patient's
  statement outranks a clinician's or a summary's. The app adds the patient's
  version and a finding; the record stays as written.
- The user's verdict always wins. Automatic passes never change an answer, a
  note, or anything edited on a detail that was confirmed or disputed. Things
  the user deletes or undoes are never made again.

## Huge exports
- Some files are huge chart prints from Epic, a common medical records system,
  running to well over a thousand pages.
- The cut: encounters come from PDF bookmarks or printed banners, then each is
  cut at its section headings, never inside a message, note, letter or
  questionnaire. About 30,000 characters per part.
- 27 kinds of part (note, messages, letter, lab results, imaging and more).
  Each is read by Claude, by the app's own parser AND Claude (messages, phone
  notes, letters, questionnaires), or skipped as boilerplate.
- Accounted for without reading: blank pages, repeat pages (never one with an
  image), repeated facesheets, scans with no words.
- Parts are packed into calls of up to about 60,000 characters and 24 pages,
  never cut mid-page; that takes about a third as many calls as one per part.
- Coverage: every page is done, parsed (read word for word without the
  model), skipped (with a reason), no text, failed, running or pending. A
  document is "done" only when every page is accounted for; otherwise screens
  say, for example, "Partly read: details from pp.1-48 of 1,840".
- The "How much was read" panel shows all this plus OCR and the lab check,
  with "Continue reading" (c) and its cost, and "Read these pages again".
- Safe stops: each call saves its work in one go, so a lock, crash or dropped
  connection costs at most one call. A failed part says why. Automatic passes
  give up on a part after 3 failures in a row.
- Reading again only replaces earlier unchecked AI details from that part. It
  never touches details the user confirmed, disputed, edited, noted or added,
  or ones the lab, medication, to-do or finding lists link to.
- When the reading rules change shape, a version number goes up. "Continue
  reading" also re-reads parts read under an older version.
- Messages inside exports go to Calls and messages with no AI: one row each,
  word for word, with whose words, a thread and a citation. A re-read or
  second export never makes a second row.

## Labs
The 12 lab rules, as built:
1. Raw text kept: value, unit, range and flag exactly as printed. Edits show
   beside "As printed: ...".
2. A value with a sign ("<", ">", "> OR =") is a limit, never a measurement.
3. Ranges keep their own signs ("<50" is an upper limit only). An unreadable
   range is kept and marked "(not read as numbers)".
4. Flags kept as printed. Blank or a dash means "no flag printed", not
   "normal". HH, LL, H!, CH and similar are critical. A flag the app works out
   is marked "by its range", with a warning if it disagrees with the printed
   one.
5. Units as printed. Only explicit, tested conversions. Nothing relabelled.
6. Words, titres and "2+" stay text.
7. Collected, resulted and received dates kept apart. Nothing guessed.
8. A value is judged only against its own printed range. The same result in
   several documents is one reading with several sources, not a trend.
9. Test names match exactly, via a checked synonym list. A test on one sample
   type is never filed as another. A vague name lists the similar tests.
10. Two values of one test, sample and day in one document that differ like a
    typo (shifted decimal, dropped sign, swapped digits) become a finding.
    Nothing is chosen or changed.
11. The source sets the role: clinical record "printed"; the patient's notes,
    summaries and outside letters "claimed" (never red, never counted out of
    range); unsorted "unclassified"; typed by the user "typed".
12. When a summary's judgement or limit differs from the lab report, that
    becomes a finding.
- Charts: a red diamond means outside the range printed with that value; a
  ring means the report flagged it. The range band is shaded only when the
  readings in view share one range. Summary values are open circles, never
  red. Limits are listed, never plotted. One chart per unit. "Overlay
  medications" (m) adds medication bars.
- Copies: each measurement shows once; copies in other documents fold in as
  "and 3 more".
- The lab check (no AI, free) runs after every reading and once at unlock. It
  finds lab lines on every page read and checks each is held by a stored
  value. Vitals, doses and reference tables are not counted.
  - Pages with misses are read again once, within the cost limit, in small
    batches naming each missed row.
  - Lines still missed are added straight from the page with a verified
    quote: "Added by the lab check from p.N". Undo works, and an undone line
    is never re-added.
  - The panel says, for example, "412 lab lines found; all pulled out".
- Computed values: an index a lab rarely prints on its own (for example an
  albumin index from paired CSF and serum albumin) can be computed by the user
  from printed inputs; it is drawn as an open square, never red, never judged
  by a range.

## The pages
Sidebar: Home, Ask the clinician and Search everything at the top, then "Your
records", "Keeping track" and "Tools". Yellow counts only where something
needs the user. Every list: j/k, Enter, Esc, h folds a group. "g" plus a
letter jumps to a page; ctrl+k "Find a page or action"; "?" the keys; ctrl+.
the clinician beside any page.

- Home (g t): a "Never give" box if any; "Waiting for you" lines with one
  button each; "For your information"; "Coming up" beside "Recently added"; a
  question box and a drop strip.
- Search everything (g /): every typed word must match; results grouped by
  kind and read in place.
- Documents (g d): add documents, import a folder (local only, copies only),
  filters for not sorted, likely copies, read in part; the viewer shows
  Summary, Page text with cited passages marked, or Original.
- Check before filing (g u): uploads the user wants to see first, with
  Claude's suggestion and how sure it is.
- Lab results (g b): every value as printed, grouped by test; views by test,
  by document, all values; sample, range and date filters.
- Scans and imaging (g i): impression and findings as prose, a word-by-word
  compare with the previous scan, a read-only image viewer.
- Medications (g m): current, all, allergies and never give, history chart,
  emergency card.
- Appointments (g e), Calls and messages (g c), Symptom diary (g s), Timeline
  (g l), Reconciliation (g q), To-do list (g k), Records checklist (g r),
  Details from documents (g f; o is "You say otherwise"), People and places
  (g p), Make a packet (g x), Import calendar or spreadsheet (g y), Ask the
  clinician (g a), What Claude noticed (g n), AI usage log (g o), How
  CaseFile works (g h), Settings (g ,).
- Print pages: the Emergency card and the Daily plan.

## Findings
- "What Claude noticed": prompts for a human look, never diagnoses.
- Built-in checks (no AI, no cost) catch date, dose or effect disagreements
  between documents; missing records that are referenced; every result of a
  test out of range; trends (3 or more results in a row moving one way by 20%
  or more); recommendations not acted on after 60 days, missed follow-ups,
  referrals not completed after 90 days; an old abnormal result nothing later
  mentions; a symptom rise within 14 days after a drug change or procedure
  (correlation only); plus the precedence rule, lab rules 10 and 12, and
  reconciliation disagreements.
- "Deep check with Claude" sends the whole ledger to the deep model for five
  kinds: disagreement, missing record, trend, overlooked, pattern in time.
  Findings without usable evidence, or worded as a diagnosis, are dropped and
  counted.
- "Is this right?": "Yes, needs follow-up", "Yes, done", "Doesn't matter",
  "Incorrect". Re-runs never touch an answer, and Claude is told what was
  already judged.

## Ask, the clinician
- Its own page (g a) or a dock beside any page (ctrl+.).
- Kinds of answer: Question, "Find in the records", "Draft a message" (nothing
  is sent), "Visit briefing".
- "Look at": everything, chosen documents, or dates; up to 10 attached
  documents per question.
- Depth, a four-step slider: Quick, Standard (default), Deep, Master
  clinician (the whole case, maximum effort; minutes and several dollars). A
  plain line under the slider gives cost and time before sending.
- Read-only tools: search the case, details, lab series, document pages,
  timeline, calls and messages, documents, coverage, threads and charts.
- Proposals (read documents again, add a lab value from a page, move
  documents to the right type), each with a state and Undo. Unasked, nothing
  happens without the user's yes.
- It cannot send anything, change the user's answers or edit a record.

## AI, models and cost
- The app talks only to Anthropic, and only when an AI action runs.
- Sorting and reading use the everyday model at low effort; deep readings,
  the deep check and the top Ask depths use the deep and master models.
- "Carry on reading up to": a per-document dollar limit (default $50; 0 means
  always ask). A reading that stopped part-way carries on alone after unlock
  if what is left costs no more; above it, Claude asks once.
- The AI usage log records purpose, model, tokens, dollars, time and result
  for every call, never the question, page text or answer.

## Settings worth knowing
- Appearance: Dark / Dim / Light, Large type, Reduced contrast, Show the keys
  on buttons.
- Patient details for the emergency card, packet covers and the wrong-patient
  guard.
- "Lock after": 30 minutes by default. Passphrase 8 characters minimum, no
  recovery. "Lock now" ctrl+shift+x.
- People with access, with the audit log. "Back up now".
- AI: Claude on/off, the API key (owner only), models and thinking effort,
  pages read at a time, the reading limit, local network access (off).

## Look and feel
- Dark is the default and must be excellent; Dim is darker; Light exists.
  Warm neutral colours. One blue-green (verdigris) accent marks state only.
- Titles in a serif (Newsreader), words in a sans (IBM Plex Sans), data in a
  monospace (JetBrains Mono). A terminal-style ledger.
- Dense and calm. Split views: list left, detail right, with a draggable
  divider.
- Every page: a serif title, a counts line, ONE plain sentence of purpose,
  then actions: one main button, two or three text buttons, the rest under
  "More".
- Text contrast at least 4.5:1 in every theme.
- Forbidden: gradients, glass effects, purple or indigo, icon card grids, hero
  sections, stat tiles, emoji, skeleton loaders, pure white, icon-only
  buttons. Loading is one muted line. Status colour always comes with a word.

## Privacy, security and safety
- Encryption: one random master key. Each person's passphrase unlocks their
  own wrapped copy. Keys derived from it open the database and encrypt every
  original file (AES-256-GCM). No recovery: a lost passphrase means a lost
  case. The API key sits inside the encrypted settings.
- Locked means no open database, no key in memory and no work running.
- Audit log (owner only): sign-ins, locks, every editor or viewer write,
  settings changes (names, never values), packets, exports, purges, access and
  passphrase changes.
- Delete is soft: the trash and "Restore". Purging is a separate action that
  first copies the original to a trash folder for 30 days.
- Backups: one zip of the encrypted database, keyring and file store, all
  still encrypted. Never overwrites an earlier one.
- Restore never replaces data in place: the current case folder is renamed to
  a dated ".bak" folder first.
- What leaves the server: only Anthropic requests, each in the AI log. Logs
  hold no passphrase, key, names, titles or page text.

## How it was built and the rules the builders follow
- Built by Claude Code agents in slices against written API contracts, then
  large review sweeps.
- The builders' rules are in CLAUDE.md: each feature keeps to its own files;
  plain CSS with shared colour tokens; database changes additive only; all AI
  calls through one file; every input validated; partial dates kept as value,
  precision and text; citations on everything the model pulled out, flagged
  never dropped; the user's verdict outranks the model; soft delete
  everywhere; selection in the page address; typecheck, tests and a build
  must pass; data safety is absolute.

## Added after this briefing was first written
- A wrong-patient guard: every document is checked against the patient
  details; a document that names someone else (another first name, another
  date of birth, a record number from another system, or someone often
  confused with the patient, such as a person with the same surname and date
  of birth) is held back as "May be someone else's record".
- Computed lab values (see Labs).
- Plan: the current care plan read from a dropped document into tabs
  (framework, checklist).
- My notes: only the patient's and the chief of staff's own writing, with a
  two-stage reconciler (records against records, then records against the
  notes) for medication timelines.
- Checked against itself: each new document's printed flags are checked
  against its own ranges (no AI) and contradictions within one note are found
  (AI, both quotes verified).
- Care team: candidates for the team, with steps, roles (Strategist, Lead
  specialist, Local doctor, Vendor), sourced facts (access type, quoted cost,
  home-state licence, earliest visit), a fixed question list with a Pass/Fail
  verdict, and an optional web search that never carries case content.

## Words the app uses
- Fact ("detail" on screen): one small statement from a document, with
  citations.
- Citation: document, page and exact quote, checked against the page text.
- Verdict: the user's answer on a detail or finding. It always wins.
- Tier: the kind of source (clinical record, the patient's notes, summary,
  outside letter, not sorted).
- Compilation: a summary, dossier or AI analysis; never outranks a clinical
  record.
- Coverage: how much of a document was read, page by page.
- Segment or part: one piece of a long document, such as an encounter or
  section.
- Finding: something "What Claude noticed"; a prompt to look, never a
  diagnosis.
- Packet: a PDF of chosen records, details and findings for a clinician or
  visit.
- Lab check: the free, no-AI check that every lab line read is held by a
  value.
- Reading: Claude pulling details out of pages.

## Reading this snapshot
This briefing, PLAN.md and CLAUDE.md explain the intent; the code is the
truth. Do not infer anything about the owner's health from the code: the lab
catalogue, examples and fixtures are generic or invented, and no records are
included.
