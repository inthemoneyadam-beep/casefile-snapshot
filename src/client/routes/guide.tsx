/**
 * /guide — "How CaseFile works": a plain-words glossary of the app for the user and the chief of staff. What happens to a document,
 * where things live, the kinds of documents, the labels on details, Reconciliation, the answers on a detail and on a
 * finding, filing and Undo, likely copies, someone else's record (the wrong-patient guard), long documents (read in part, Continue reading, threads, whose words, people
 * listed twice), labs, medication rows, the clinician, and what is never lost. Static text;
 * the menu section list is read from nav.ts so it never goes stale. "On this page" at the top jumps to a section (the
 * palette has the same jumps); the words are the ones the tags and buttons use, never the stored codes.
 */
import type { ReactNode } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { NAV, NAV_GROUPS } from '../app/nav';
import { useRegisterCommands } from '../app/commands';
import { PageHeader, Section } from '../ui/PageHeader';
import '../features/guide/guide.css';

export const Route = createFileRoute('/guide')({ component: GuidePage });

/** The sections, in order: the "On this page" list, the palette's jumps and each section's id (guide-<key>). */
const SECTION_TITLE = {
  idea: 'The idea in one minute',
  kinds: 'Kinds of documents',
  labels: 'The labels on details',
  reconciliation: 'Reconciliation',
  answer: 'Your answer (on a single detail)',
  findings: 'What Claude noticed (findings)',
  selfcheck: 'Checked against itself',
  filing: 'Filing, Undo and nothing lost',
  copies: 'Likely copies',
  patient: "Someone else's record",
  reading: 'Long documents, messages and people',
  labs: 'Labs',
  medications: 'Medication rows under the charts',
  plan: 'Your plan',
  notes: 'My notes, and your notes against the records',
  careteam: 'The care team and web search',
  clinician: 'The clinician',
  where: 'Where things live',
} as const;
type SectionKey = keyof typeof SECTION_TITLE;
const SECTION_KEYS = Object.keys(SECTION_TITLE) as SectionKey[];

function jumpTo(key: SectionKey) {
  const el = document.getElementById(`guide-${key}`);
  if (!el) return;
  el.scrollIntoView({ block: 'start' });
  // The heading takes the focus, so Tab carries on from the section (and a screen reader reads where it landed).
  const h = el.querySelector<HTMLElement>('h4');
  if (h) {
    h.tabIndex = -1;
    h.focus({ preventScroll: true });
  }
}

function Terms({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="guide-terms">
      {items.map(([term, meaning], i) => (
        <div key={i} className="guide-term">
          <dt>{term}</dt>
          <dd>{meaning}</dd>
        </div>
      ))}
    </dl>
  );
}

function GuidePage() {
  useRegisterCommands(
    SECTION_KEYS.map((k) => ({
      id: `guide.${k}`,
      title: `How CaseFile works: ${SECTION_TITLE[k]}`,
      group: 'Page',
      keywords: 'guide help words glossary',
      run: () => jumpTo(k),
    })),
    [],
  );
  return (
    <div className="page guide">
      <PageHeader title="How CaseFile works" intro="The words and buttons you will meet, in plain terms. Nothing here changes anything." />
      <div className="page-body guide-scroll">
        <div className="guide-body">
          <nav className="guide-toc" aria-label="On this page">
            <h4 className="guide-toc-title">On this page</h4>
            <ol>
              {SECTION_KEYS.map((k) => (
                <li key={k}>
                  <a
                    href={`#guide-${k}`}
                    onClick={(e) => {
                      e.preventDefault();
                      jumpTo(k);
                    }}
                  >
                    {SECTION_TITLE[k]}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
          <Section title={SECTION_TITLE.idea} id="guide-idea">
            <ol className="guide-steps">
              <li>You add documents (drop files anywhere, or Add documents).</li>
              <li>Claude reads each one, gives it a clear name, sorts it (lab report, clinic note, phone call…) and files what it holds: calls, appointments, medications, lab values, scans.</li>
              <li>Every detail is checked automatically against your clinical records. Most need nothing from you.</li>
              <li>You only step in where your records disagree and no record settles it: that is the Reconciliation page.</li>
              <li>Ask the clinician anything about the case; answers cite the pages they come from.</li>
            </ol>
          </Section>

          <Section title={SECTION_TITLE.kinds} id="guide-kinds">
            <p className="guide-p">Each document has a source type. It decides what the document counts for.</p>
            <Terms
              items={[
                [
                  'Clinical record',
                  'An actual hospital or clinic document: lab report, scan report, clinic note, procedure report, discharge summary. For measurements and dates it is the truth. Among records, the test’s own report (the lab report for a lab value) outranks a note that repeats it.',
                ],
                [
                  'Your own notes',
                  'Written by you or your chief of staff. For how a treatment felt, whether it helped, how a symptom ran, your word is the primary source and outranks a clinician’s note. It never overrides a measured value unless you say the record is wrong.',
                ],
                ['Summary', 'A summary, dossier or timeline put together from other records (including ones Claude wrote). It never outranks a clinical record.'],
                ['Outside letter', 'From an insurer, employer, school or advocate.'],
                ['Not sorted yet', 'Claude has not sorted it yet (usually because the AI key was not working). Sort it from the document page.'],
              ]}
            />
          </Section>

          <Section title={SECTION_TITLE.labels} id="guide-labels">
            <p className="guide-p">Every lab value, scan, procedure and event gets a label automatically. None of them asks for an answer.</p>
            <Terms
              items={[
                ['verified', 'It comes from a clinical record.'],
                ['accurate', 'Another document (a call, a summary, your notes) says the same as the clinical record. Copies are folded into the record so nothing is counted twice.'],
                ['not backed yet', 'Nothing to compare it with yet. Adding the clinical record will check it. Nothing to do.'],
                [
                  'not compared',
                  'A record is there, but the two could not be compared safely (another unit, other wording, a scan described differently). What the record says is shown beside it; read both if it matters.',
                ],
                [
                  'inaccurate',
                  'It contradicts a clinical record: another value, or a date close to the record’s. Only that line is marked, never the whole document. The record’s value is the one used.',
                ],
                ['needs a source', 'Your documents disagree with each other and no clinical record settles it. These are the only items that wait for you (Reconciliation).'],
                ['replaced', 'A newer reading, or a duplicate you merged, is used instead.'],
              ]}
            />
          </Section>

          <Section title={SECTION_TITLE.reconciliation} id="guide-reconciliation">
            <Terms
              items={[
                [
                  'Needs a source',
                  <>
                    Disagreements no record settles. <strong>Upload the record</strong> (or <strong>Use a document already here</strong>) and every mention is checked against it at once. Without a
                    record: <strong>This one is right</strong> on the version you know is right (a reason helps). When two clinical records disagree: choose the right one, or{' '}
                    <strong>Both happened</strong> if they are two separate readings or occasions.
                  </>,
                ],
                [
                  'Inaccurate',
                  <>
                    Each wrong bit of information in red, with what the record says. <strong>It&apos;s actually right</strong> keeps it as accurate. <strong>Not the same event</strong> says it is
                    another occasion (another test, another day). <strong>The record is wrong</strong> uses your version instead and keeps the record as written; use it only to correct a clinical
                    mistake.
                  </>,
                ],
                ['Settled', 'Events a clinical record settles, with the mentions that match it.'],
                ['Not backed yet', 'Events with no record yet. Information only.'],
              ]}
            />
          </Section>

          <Section title={SECTION_TITLE.answer} id="guide-answer">
            <p className="guide-p">Closed by default; only needed when you know better than the automatic check.</p>
            <Terms
              items={[
                ['It’s accurate', 'You checked: this detail is right, whatever other documents say.'],
                ['Not sure', 'You looked and cannot tell.'],
                ['It’s wrong', 'The detail is wrong. It stays on file but the clinician will not rely on it.'],
                ['The record is wrong', 'The clinical record made a mistake; your version is used for this event (with a reason). The record itself is never changed.'],
                ['Back to automatic', 'Forget your answer and let the app compare it again.'],
              ]}
            />
          </Section>

          <Section title={SECTION_TITLE.findings} id="guide-findings">
            <p className="guide-p">
              Contradictions, gaps and patterns Claude found across the records. The buttons answer one question, <em>Is this right?</em> They never pick a side between two documents:
              where your own account takes precedence (how something felt, whether a treatment helped), your version is already the one used.
            </p>
            <Terms
              items={[
                ['Yes, needs follow-up', 'It is right and something still needs doing: raise it with a doctor, get a missing record, or have a summary corrected. It stays open, and the clinician sees it as live.'],
                ['Yes, done', 'It is right and it is handled now (pressing the button is the doing). It closes, stays on file as a real issue, and still goes into packets you make.'],
                ["Doesn't matter", 'True or not, it does not matter for your case. It closes and is left out of packets you make.'],
                ['Incorrect', 'Claude got it wrong: there is nothing there. It closes.'],
                ['Undo my answer', 'The finding is open again. Whatever you answered, Claude does not raise the same thing again.'],
                ['Add to to-do list', 'Turn it into a task (for example: ask the clinic to correct their summary). Press Yes, done once the task is done.'],
              ]}
            />
          </Section>

          <Section title={SECTION_TITLE.selfcheck} id="guide-selfcheck">
            <p className="guide-p">
              A new document from a hospital or clinic is checked against itself, never against your other records. You answer what it finds with the same Is this right? buttons, and each finding
              says which place it came from, so you can see what each place&apos;s records are like.
            </p>
            <Terms
              items={[
                ["Flag doesn't match the value", 'The report marks a lab value high or low, but the value and the range printed with it say otherwise: L above the range, H below it, or H or L inside it. The app checks this itself, free, without Claude. Only numbers with a range printed in the same unit; never a limit like "<3", never words, never a summary or your own notes. Not a value right on the edge of its range: labs flag the unrounded number.'],
                ['Contradicts itself', 'Claude reads each note of the document for two things that cannot both be true: left and right, a symptom denied and present, a drug stopped and continued, two doses, two dates for one event, a normal exam and an abnormal finding, a number in the text and another in a table, the assessment against the history. Both passages are quoted with their pages. It never says which one is right.'],
                ['Not found word for word', 'A quoted passage Claude gave that is not on the page exactly. It is kept and marked, never dropped; read the page to be sure.'],
                [
                  <>
                    Check it against itself <span className="muted">(a)</span>
                  </>,
                  'Under More on any document. For documents added before this check existed, or to check again. You see the cost first. From Documents, More checks all the documents shown at once.',
                ],
                ['Cost', 'New documents are checked by themselves up to your limit in Settings, Advanced. Above it, the document asks you once: Check it, or Not now (kept).'],
                ['Per place', 'People and places shows, for a hospital or clinic, how many flags did not match and how many contradictions its documents had. So does the document, under How much was read.'],
              ]}
            />
          </Section>

          <Section title={SECTION_TITLE.filing} id="guide-filing">
            <Terms
              items={[
                ['Filed automatically', 'Claude files what a document holds without asking. Each placement on the document page has an Undo.'],
                ['Undo', 'Takes back what Claude filed. Something you undo or delete is never made again automatically, from any document.'],
                ['Medications', 'Added automatically only from clinical records and your own notes, never from summaries. Add others on the Medications page: More, Find medications in your documents.'],
                ['Deleting', 'Everything you delete goes to the trash and can be restored. Your answers and notes are never overwritten by the app.'],
              ]}
            />
          </Section>

          <Section title={SECTION_TITLE.copies} id="guide-copies">
            <Terms
              items={[
                ['Looks like a copy of…', 'The same document added twice (a portal download with a new print date, say). It is still read and filed like any document.'],
                ['Set this copy aside', 'Moves the copy to the trash and takes back what was filed only from it. Allergies and anything the original also lists stay. Restore brings it back.'],
                ['Keep both', 'They are two documents; the note goes away for good.'],
              ]}
            />
          </Section>

          <Section title={SECTION_TITLE.patient} id="guide-patient">
            <p className="guide-p">Before Claude reads a new document, every page is checked for the patient printed on it: the name, date of birth and record number. A document that names someone else is held back.</p>
            <Terms
              items={[
                [
                  "May be someone else's record",
                  'Held back: nothing is read or filed from it. Its details are hidden from labs, search, the clinician, packets and the lab check until you answer, and what Claude had filed from it (medications, visits) is taken back. Allergies stay (a missing allergy can hurt), and so do ones you changed: it says to check them. It says which pages name someone else.',
                ],
                [
                  'Someone else',
                  'Another first name or initial, another surname, another date of birth, another record number from a hospital on your list, or the name of someone often confused with you (such as a twin). A date of birth alone never says it is you.',
                ],
                [
                  <>
                    It&apos;s mine <span className="muted">(m)</span>
                  </>,
                  'It comes back with its details, and Claude carries on. The answer is kept: the same pages are never held back again. If it prints a record number from a new hospital, one button adds it to your list.',
                ],
                [
                  <>
                    Not my record <span className="muted">(w)</span>
                  </>,
                  'It goes to Deleted documents with the reason "wrong patient" (you are asked first). Restore brings it back held, to check again. It is under More on every document too.',
                ],
                ['Patient not confirmed on document', 'Nothing on it says whose it is, or only an initial or a date of birth. It is read as usual; its page says so.'],
                [
                  'Patient details',
                  'In Settings: your name and date of birth, other first names you go by, someone often confused with you, and your record numbers, each with the hospital that gave it. Without your name and date of birth nothing can be checked, and Home asks for them. A change checks every document again.',
                ],
                ['Where to answer', "Check before filing, under Show: May be someone else's record. Home and Documents say when one is waiting."],
              ]}
            />
          </Section>

          <Section title={SECTION_TITLE.reading} id="guide-reading">
            <p className="guide-p">A hospital chart print can run to thousands of pages, with visits, scanned pages and your portal messages inside it. Claude reads it part by part and keeps count of every page.</p>
            <Terms
              items={[
                ['Uploaded and analysed', 'The notice at the top after an upload says the whole file arrived and every page was stored, then follows it until every page is read: "All 1,840 pages read; details from all 1,840 pages". If anything is missing it says exactly what.'],
                ['Read in part', 'Claude has details from only some pages ("details from pp.1-48 of 1,840"): the reading stopped (a lock, a restart, a dropped connection) or some pages could not be read. The document says which pages, and why.'],
                ['Continue reading', 'Carries on from where the reading stopped; pages already read are not read again, and details you checked are kept. Up to the amount set in Settings, Advanced, Claude carries on by itself after a restart; above it, it asks you once, and "Not now" is kept.'],
                ['Lab check', 'After every reading the app reads each page Claude read for lab result lines itself, without the model, and checks that every line is in your lab table ("Lab check: 412 lab lines found; all pulled out"). Pages with a line missing are read again once; a line still missing after that is added from the page, quoting it, and its detail says "Added by the lab check". How much was read lists the lines it added or still misses.'],
                ['Read these pages again', 'Reads exactly the pages named, even pages read before. Details you checked or edited are kept, and nothing is copied twice.'],
                ['Scanned pages', 'Pages that are pictures (an after-visit summary, a faxed report) are read letter by letter (OCR). The printed page is never changed; the text read from the picture is added under it.'],
                ['Skipped pages', 'A page that repeats an earlier one word for word with no picture on it, a blank page, or a repeated cover sheet. Each is counted with its reason; a page with a picture is never skipped.'],
                ['Threads', 'On Calls and messages, the portal messages and replies read out of a record are kept word for word, each as its own message, and shown as conversations, oldest first. "From records" and "You" tell them apart from the ones you logged.'],
                ['Whose words', 'Each message says who wrote it. Your own words inside a clinical record count as yours, not as the record: a value you quote in a message is not a lab result, and a drug you mention is not a prescription.'],
                ['Model summary', 'A short summary Claude wrote of a message or a conversation. It is always labelled, and never replaces the message itself.'],
                ['Copies of a message', 'A message you filed separately (a saved portal message) and the same message inside a chart print are one message: the copy is linked, never counted twice.'],
                ['Listed twice', 'The same person written in different ways ("Example, Robin RN" and "Robin Example"). People and places offers to merge them; nothing is merged unless you say so, and a merge can be undone.'],
              ]}
            />
          </Section>

          <Section title={SECTION_TITLE.labs} id="guide-labs">
            <Terms
              items={[
                [
                  'As printed',
                  'Every value, unit, normal range and flag is shown exactly as the document printed it. Nothing is rounded, relabelled or tidied; a unit printed twice ("cells/uL cells/uL") is shown once, with a note.',
                ],
                ['A limit ("<3")', 'The test reads below 3 (or above 1700 for ">1700"). It is a limit, not a measurement of 3: it is listed, never drawn as a point or compared as if it were 3.'],
                ['Flag on the report', 'The H, L or other mark the report printed beside the value. "None printed" means the report printed no flag, which is not the same as "normal".'],
                [
                  'By its range',
                  'Worked out by the app from the value and the range printed with it. When this and the report’s flag disagree (112 against 98–108 with no flag printed), a plain warning says so.',
                ],
                [
                  'Ranges belong to their lab',
                  'Each value is judged only by the range printed with it. Different labs print different ranges, so one lab’s range is never used for another’s value; a chart shades a range only when the values in view share one.',
                ],
                [
                  'A summary’s words',
                  'A summary, dossier or note that calls a value "normal" or uses its own limit is making a claim. It is never marked red. When it differs from the lab report, What Claude noticed says so.',
                ],
                [
                  'Collected, Resulted, Received',
                  'Kept apart: when the sample was taken, when the result came back, and when the lab received it. "Date" with a note means the document did not say which.',
                ],
                ['One test, many names', '"ICP (opening pressure)", "OP" and "Opening pressure" are one test; so are the spellings of cell counts, appearance, color and the rest.'],
                [
                  'Similar names, different tests',
                  'IgG index, serum IgG, CSF IgG and IgG synthesis rate are different tests; so are albumin index, Qalb, CSF albumin and serum albumin, or CRP and hs-CRP. They are never merged. Asking for a name that could mean several of them gives no values and names the choices.',
                ],
                [
                  'Two values in one document',
                  'When one document gives two values for one test on one day that differ by a decimal point or a dropped sign (0.08 and 0.8), neither is chosen. Both are shown with their pages under What Claude noticed; the original report decides.',
                ],
                [
                  'from one line',
                  'A document wrote several tests on one line ("OP 17; protein 52"). Each test is shown under its own name, with the line it came from. A line that cannot be split safely is kept whole and labelled "one line, several tests".',
                ],
                ['Results in words; no chart', 'Results like Negative, Clear or Not detected are listed by date, not charted. Positive or abnormal ones are tagged.'],
                [
                  'Units',
                  'Each value keeps the unit it was printed in. Units that convert exactly (mg/dL and g/L, cmH2O and mmHg for pressures) can be drawn on one chart, with the original kept; others get a chart of their own, never mixed.',
                ],
                ['Values re-read', 'Labs, More: what changed when the app re-read your lab values from the text as printed, with counts and examples. Nothing you entered was overwritten.'],
                [
                  'Computed value',
                  'A value you work out from values printed on lab reports, when the lab does not print it: the albumin index, the IgG index, or A divided by B times k. Labs, "Add a computed value" (c). Only printed values can be used; a limit ("<3") or words cannot.',
                ],
                [
                  'Pairing and units',
                  'Values from one sample come from one collection day. CSF and serum may be drawn up to 48 hours apart; the gap is shown. Units convert only between mg/dL, g/dL, g/L and mg/L; any other unit is refused, by name.',
                ],
                [
                  'Open square',
                  'A computed value on the chart. It shares the line with the lab’s own printed values of that index. Never red, never judged by a range. It says "Computed by you from p.N and p.M".',
                ],
                ['Range you typed', 'Your own range for a computed value, drawn as dashed lines. It never makes a value red.'],
                [
                  'Input changed: compute again',
                  'An input was edited, marked wrong or removed after you computed the value. The value is kept as it was, never recomputed by itself. "Compute again" opens it with the same inputs.',
                ],
                ['Lab printed a different value', 'When the lab prints the same index for the same collection and it differs from yours at the lab’s precision, What Claude noticed says so. Nothing is changed.'],
              ]}
            />
          </Section>

          <Section title={SECTION_TITLE.medications} id="guide-medications">
            <Terms
              items={[
                ['Solid bar', 'From a start date a document actually stated.'],
                [
                  'Dashed bar, start not recorded',
                  'Only the date the drug was first mentioned is known (a medication list, a note). The bar runs from that first mention and says "start not recorded"; the list says "not recorded", with the first mention on hover. It is never shown as a start.',
                ],
                ['Arrow at the right', 'You are still taking it.'],
                ['End mark', 'Where it stopped.'],
              ]}
            />
          </Section>

          <Section title={SECTION_TITLE.plan} id="guide-plan">
            <p className="guide-p">
              Add your plan on the Plan page (a PDF, a Word file, a text file or a photo; or drop it on the page). It is kept in Documents like any file, and Claude reads it into the plan. You
              see the cost while it reads; above your limit per document it asks first. The plan&apos;s own words are never changed.
            </p>
            <Terms
              items={[
                ['Framework', 'The plan as an outline: sections, goals, steps, and decisions with their branches ("If ...").'],
                ['Checklist', "Everything to do or check. Mark each one done (x), skipped (s) or doesn't apply (a); it keeps who and when. Press the same key again to put it back."],
                ['Timeline', 'Items with a date first, then the plan’s own words for when ("within 1 hour"), then what applies only when something happens.'],
                ['Original', 'The plan document with the passage each item came from marked. A quote not found on the page is kept and marked "not found on the page".'],
                ['As written', 'When you change an item (its words, who or when), the plan’s own wording stays beside yours.'],
                ['Make a to-do', 'Puts an item on the To-do list. The to-do and the item point to each other.'],
                ['A new plan', 'Adding a plan makes it the current one once it is read. The old one is kept, replaced, with its checklist. Nothing carries over by itself: the new plan says which items look the same as finished ones, and Mark them marks them in one click.'],
                ['The clinician', 'Reads the current plan and cites it as the plan document. It is what was planned, not a record of what happened.'],
              ]}
            />
          </Section>

          <Section title={SECTION_TITLE.notes} id="guide-notes">
            <p className="guide-p">My notes holds only your own writing and your chief of staff's, never a clinical record. Records don't always keep things straight, medicines above all, so your notes are set beside them.</p>
            <Terms
              items={[
                ['Import notes', 'Drop many files at once, a zip or a folder on My notes. Text, Word, PDF, web pages, Rich Text, spreadsheets of entries, Google Keep (Takeout) and Evernote all work. Each note is filed as your own note.'],
                ["A note's date", 'Its own: a date written at the top, else the date the export kept, else a date in the file name. Only when there is nothing else, the file’s own date, and then it says "date from the file".'],
                ['Copies', 'A note you already have is skipped. One that is nearly the same says "looks like a copy of".'],
                ['Reading them', 'Nothing is read until you say so. You see one cost for the whole import first. Short notes are read several at a time; each detail stays with the note it came from.'],
                ['agrees, differs', 'How each entry stands against your records. "records disagree first": the records must be settled before your note is compared. "nothing to compare": the records say nothing about it.'],
                ['Records vs records', 'In Reconciliation (press 1). Where two clinical records disagree. Medications shows each drug, one row per record and per note. Answer: This record is right, Both happened, or This record is wrong.'],
                ['Records vs my notes', 'In Reconciliation (press 2). Your notes against the settled records. My notes are right: your version is used and marked "per my notes"; the record stays as written. The records are right. Both are true: two different things. Not the same thing.'],
                ['On Medications', 'Once you answered on a drug, its start and stop are the settled ones, and each says who said it ("per my notes", or the record). Undo puts it back.'],
                ['The clinician', 'Knows what you settled and says "per your notes" where your version won.'],
              ]}
            />
          </Section>

          <Section title={SECTION_TITLE.careteam} id="guide-careteam">
            <p className="guide-p">Care team (Keeping track) is everyone who could look after a flare. One row each, with a source for every fact. The list goes in the order you are working: by step, then status.</p>
            <Terms
              items={[
                ['Step', '1 Local doctor, 2 Flare plan, 3 Lead specialist, 4 Expert. The order you are working in. Filter by step, or group by step.'],
                ['Role', 'Strategist (sets the plan), Lead specialist (runs things week to week), Local doctor (close by: treatment, labs), Vendor (a service: home infusion, pharmacy, nursing).'],
                ['Status', 'Found, Contacted, Call booked, Answered the flare test, Shortlisted, Declined, Chosen. Call booked asks when: a day and a time. Every change is kept with who and when.'],
                ['Access, cost, home state, visit', 'Access type (Cash-pay priority, Formal arrangement, Insurance, Unknown), quoted cost as they said it, licensed in the home state (Yes, No, Would get it, Unknown), earliest visit. Each needs a source. Unknown needs none.'],
                ['Flare test', 'Eight fixed questions: first hour, who places the treatment order, where it is given, weekends, message response time, monitoring commitment, home-state license, cost and what is included. The home-state license row is the same answer as Licensed in home state. Typed by you or your chief of staff. Claude never fills it in.'],
                ['Pass or fail (d)', "Your verdict on the flare test, with one line on why. Pass: they name the person who places the treatment order and give a time in hours. 'Assess and direct to appropriate care' is a fail."],
                ['Source', 'A web page (its link and the day you read it), or "told us by phone" (who said it, and when). Each fact and each flare test answer has its own.'],
                ['not backed yet', 'No source says it as it reads now. A fact you change goes back to not backed yet until you give it a source.'],
                ['unverified', 'Only a web search says it. It stays unverified until you tick Verified by phone (p) with who called and when. Unticking brings it back, and Undo puts the tick back.'],
                ['Calls and to-dos', 'Log a call (c) puts it in Calls and messages; Add a to-do (t) puts it on the To-do list. Both stay linked to the candidate.'],
                ['Home', 'Coming up shows open care team to-dos with the name, and the next flare-test call. Not for someone marked Declined. Click one to open the candidate.'],
                ['Make a packet', 'Tick Care team summary for one page: everyone on the list by step, with status, pass or fail, cost, access, home-state licence and earliest visit. Read it before you decide.'],
                ['Find candidates', 'Under More (w). Off until you use it. You type the condition, the kind of clinician, the role, a place, a licence state. Check shows each search as it will be sent, and the cost. Only then can you send it.'],
                ['Search scope', 'Find doctors (the usual): only doctor-finding sites, the licensing boards of the states you name, the sites of the people on your list, and your hospital and university sites (Settings). The search tool itself keeps to them. Open: any site. Settings, AI, Web search.'],
                ['Never sent', 'Your name, the names in Patient details, your date of birth, your age, record numbers, any long number, and any six words in a row from your records. A search holding one is refused and shown as refused. Nothing is sent until Patient details hold your name and date of birth.'],
                ['Waiting for your yes', 'What a web search found. Yes adds it at Found. No keeps it turned down, so it is never suggested again. Nothing is added by itself.'],
                ['Search the web (Ask)', 'A switch under the question, off by default and off again after each question. The clinician searches in a separate request that sees nothing of your case. What it finds is listed as Outside sources (web), never as citations of your records.'],
                ['Web searches', 'The Care team view that lists every web search: the exact words sent, the ones refused, the scope and the sites allowed, the cost. The AI usage log keeps the cost, never the words.'],
              ]}
            />
            <p className="guide-p">Keys on the Care team page: n add, e edit, s status, f flare test, d pass or fail, b add a source, p verified by phone, c log a call, t to-do, y and x for yes and no, w find candidates. The clinician can read the care team, but never changes it.</p>
          </Section>

          <Section title={SECTION_TITLE.clinician} id="guide-clinician">
            <p className="guide-p">
              Sees everything: every document, the labels above, your notes on any item, and what is waiting in Reconciliation. Answers cite the page they come from. You can attach a document to a
              question to settle something with it. It relies on clinical records for measurements and on your account for how things felt. It knows which pages of a long document were not read
              and says so. When you ask it to read documents again or to move them to another type, as many as you name, it does it at once; anything it suggests on its own waits for your
              approval in the conversation, with one button to say yes. Ask it to put a lab value from a page in your table ("Can you add it to the table?") and the app adds that line from the
              page itself, with Undo under the answer; its detail says the clinician added it at your request. It may suggest computing a value (an albumin index) from printed values; that always waits for your yes. Dates and times it reads are your own time zone's.
            </p>
          </Section>

          <Section title={SECTION_TITLE.where} id="guide-where">
            {NAV_GROUPS.map((g) => (
              <div key={g || 'top'} className="guide-group">
                {g ? <h5 className="guide-group-title">{g}</h5> : null}
                <Terms
                  items={NAV.filter((n) => n.group === g).map((n) => [
                    // n.to is a page held as a string, so the router cannot type it: the cast stays.
                    <Link key={n.to} to={n.to as never}>
                      {n.label}
                    </Link>,
                    n.hint,
                  ])}
                />
              </div>
            ))}
          </Section>
        </div>
      </div>
    </div>
  );
}
