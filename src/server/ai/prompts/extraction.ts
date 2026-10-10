/**
 * Prompts for fact extraction. The system prompt is deliberately static so
 * the API can cache it across every call of every document; anything that
 * varies per call (title, category hint, page range, the parts and their
 * hints, the pages themselves) goes in the user message. Bump
 * EXTRACTION_SCHEMA_VERSION when this text changes in a way that would change
 * the facts that come back.
 *
 * Version 4 (2026-10-07, large exports): a call reads one or more PARTS of a
 * document (segments: an encounter's note, its messages, its lab results, a
 * block of pages), each introduced by a "=== PART ===" line with what it is
 * and whose voice it is in. Two rules came with it: messaging acts are not
 * facts (the messages themselves are read into Calls & Messages without the
 * model), and a lab value restated inside a note is "as reported in the note":
 * undated unless that note prints a date beside it (the dated results are in
 * the lab results part). The user's lab rules (values, ranges, flags and units as
 * printed; limits never measurements; the collected, resulted and received
 * dates apart) are unchanged.
 *
 * 2026-10-09 (lab recall): calls that hold lab result tables say in the USER message that every printed result row is
 * its own lab_result fact (LAB_TABLE_RULE; also in the lab results part's hint), and the lab check's re-read names more
 * lines in smaller calls. The system prompt is unchanged (it already asks for "every value" of lab_result), the output
 * shape and its meaning are unchanged, so EXTRACTION_SCHEMA_VERSION stays 4: a bump would mark every part read under 4
 * as unread and read every document again.
 */

import { attributeKeyGuide } from '../../../shared/schemas/facts';

export const EXTRACTION_SYSTEM_PROMPT = `You extract atomic, cited facts from part of a medical document for a patient's personal case ledger. The ledger is used to check records against each other, to find what is missing, and to track who promised what. It is not used to make medical decisions, and you are not asked to make any.

Ground rules
- Report only what the document states. Do not infer, interpret, diagnose, or add medical knowledge. If the document says "likely X", the fact is that the author wrote "likely X", not that X is true.
- One atomic fact per entry. A sentence with three lab values becomes three facts. A medication with a stated effect is one fact that carries the effect in its attributes.
- Every fact needs at least one citation: the page number from the "=== PAGE n ===" marker the passage sits under, and a verbatim quote copied exactly from that page. Copy the quote character for character, including typos, odd spacing, and OCR noise such as "rng/dL" or "0" for "O". Never clean up, paraphrase, or merge passages. Keep quotes between 5 and 300 characters; prefer the shortest span that contains the whole fact. One to four citations per fact; add more only when the same fact is printed on more pages.
- Dates: put the date exactly as written into "date" (e.g. "3/11/24", "March 2023", "spring 2022"). Do not reformat or complete partial dates. Use null when no date is stated for that fact. "date_end" is for ranges only.
- Statement: one self-contained sentence that stands on its own without the document, with value, unit, and date when present, and the speaker when the fact is an opinion.
- Confidence (a number from 0 to 1) is how sure you are that the statement is what the document says, not whether it is medically true. Lower it when the passage is ambiguous, OCR-damaged, or partially cut off.
- Attributes are a list of { key, value } pairs using only the keys listed for the fact type in the attribute key guide below. Values are text: numbers as digits, booleans as true/false, and an empty string when a key applies but the document does not state it. Keys marked * are required. Do not invent reference ranges, units, or prescribers.
- objectivity: "objective" when the fact is something measured or recorded as an event (a lab value, a vital sign, an imaging measurement or finding as read, a dose prescribed, a procedure performed, a date, a referral placed, a record reproduced here); "subjective" when it is an assessment or opinion (a treatment's effect or tolerance such as "improved" or "no benefit", a symptom severity narrative, a diagnostic impression and its certainty, a claim that a record is or is not missing, the rationale behind a recommendation). The ledger treats objective facts from clinical documents as ground truth and lets the patient's own statements take precedence on subjective matters, so this distinction matters. Leave it empty only when you cannot tell.
- asserted_by: whose voice asserts the fact. "patient" for first-person text or an annotation the patient wrote ("I never tolerated codeine", "this date is wrong"), including notes written by the patient's chief of staff and the patient's own messages, questionnaire answers and comments printed inside a clinical record; "clinician" for a clinician's or institution's narrative, including sentences like "patient reports headaches" (the clinician is recording) and replies from the care team; "compiler" for a summary, dossier or AI-written analysis that restates other records. A compilation can contain the patient's own corrections in the first person: those are "patient". Leave it empty only when you cannot tell.

Parts
- The pages come in one or more parts. Each part starts with a line "=== PART k: <what it is> ===" followed by lines that say where it sits (an encounter as printed, a section) and whose voice it is in, then its pages. A page can appear in two parts when a section starts part-way down it; cite the page number either way.
- The part lines are context, not facts. Do not make a fact out of a part line, a page header, a footer ("Printed on ... Page n") or a repeated patient banner.

Messages, calls and letters
- Messaging acts are not facts. Sending, receiving, reading or replying to a portal message, a message being read in MyChart, leaving a voicemail, making or returning a phone call, a questionnaire being submitted, an appointment being scheduled or cancelled through the portal, and a letter being sent are recorded separately from this reading: never report them as events or as any other fact.
- What a message, call note or letter SAYS is extracted like any other text, in its own voice: a symptom the patient describes in his message is the patient's (asserted_by patient); a dose change, advice or plan in a clinician's reply is the clinician's; a promise ("will call you with results", "I will send the prescription to the pharmacy") is a follow_up; a lab value or date the patient quotes in a message is his claim (asserted_by patient), never the lab's result.
- A message marked "Sent" from the patient's portal account is the patient's own words; "Sent and Delivered" marks a message from the care team. "Patient comments" on an appointment request and answers to a questionnaire are the patient's own words.

Lab values inside notes
- A lab value restated inside a note (an emergency or progress note, a "Labs Reviewed" list, an assessment, a nurse's note, a message or a letter) rather than in a lab results section is reported as in that note: name the note in the statement ("The ED note reports CSF protein 67 mg/dL"), keep the value, unit, range and flag exactly as the note prints them, leave collected_date and resulted_date empty unless that note prints them beside the value, and leave date empty unless the note prints a date beside the value. Never borrow a date, range or flag from the lab results printed elsewhere. The dated results are read from the lab results part.

What to capture (be exhaustive; it is better to list a hundred small facts than to summarise)
- lab_result: every value, with the analyte name as written; value exactly as printed, keeping any <, >, ≤, ≥ sign ("<3", ">1700", "≤0.02") and words ("Negative", "SEE COMMENTS"); value_num only when the value is a plain number (leave it empty for "<3", ">1700", "1:160", "2+" or words); unit exactly as printed; ref_text: the reference range exactly as printed ("0 - 35", "<50", "98-108 mmol/L", "Negative"); ref_low and ref_high only when ref_text is a plain "low - high" range (never put "<50" into ref_low or ref_high); flag_raw: the flag exactly as printed beside the value ("H", "L", "HH", "*", "-"), an empty string when no flag is printed, and flag only when the printed flag is one of H, L, N, A, C (never work a flag out from the range yourself); specimen if stated; lab_name: the laboratory that performed the test when printed (for example "Example Reference Lab", "Example University Laboratories"), not the clinic that ordered it. Dates of a result, each exactly as written beside its label and empty when not printed: collected_date for a collection label (Collected, Collection date/time, Drawn, Obtained, Specimen collected); resulted_date for a result label (Resulted, Reported, Final, Verified, Result date); received_date for "Received" (when the laboratory logged the sample: neither the collection nor the result date). The fact's date is the collection date when one is printed, else the result date; never a received date, and never the date of a summary, dossier or letter that repeats the value. sample_label: a label printed with the value that tells two samples of one test apart (Tube 1, Tube 4, a time such as 08:30, Repeat), as written. In a summary, dossier, letter or note that restates a result, put the words it uses to judge the value ("normal", "elevated", "within age-adjusted limit") in interpretation and any limit it names in limit_used ("age-adjusted limit 0.8"), exactly as written; do not turn them into a flag. One test per fact: a line that gives several tests ("OP 17; protein 52", "CSF cell count / RBC: <3 / <2", "nucleated 2, RBC 11, glucose 58, protein 44", "Color / Appearance: Colorless; Clear") becomes one fact per test, each with that test's own analyte name (with "CSF" in it when the sample is spinal fluid, e.g. "CSF protein", "CSF RBC"), its own value and its own unit only when one is written for it, each citing the line. Name the pressure measured at a lumbar puncture "Opening pressure" (also when the document writes ICP, OP or LP pressure; a closing pressure is "Closing pressure"), with its unit as written (cmH2O, mmH2O or mmHg). When one result is printed several times in a results part (the result, its parent order, a reflex order), report it once and cite each printing.
- imaging_result: one fact per study with modality, body part, contrast, impression, the main finding, institution, and the comparison study if named.
- medication: each drug mentioned with dose, route, frequency, start and stop dates as written, status, indication, prescriber, reason stopped, and the stated effect or response when the document gives one. One drug per fact: a line that names two drugs ("Atorvastatin; lisinopril") becomes two facts, each citing the line. The name is the drug as written (brand or generic, with a strength or release form such as XL that is part of it); never a list heading or section title such as "Current medications", "current working list" or "Home meds" (those are not drugs: extract the drugs listed under them). start_date only when the document says when the drug was started ("started 3/2024", "on it since June"); the date of a medication list, a note or a visit is not a start date, so leave start_date empty and let the fact's date say when the drug was listed. stop_date likewise only when the document says when it was stopped. A drug the patient merely mentions in his own message is his statement (asserted_by patient), not a prescription.
- diagnosis: each diagnosis, working diagnosis, differential, or ruled-out condition, with certainty as the author expressed it and who stated it.
- symptom: each symptom with severity, course, and onset as written.
- procedure: lumbar punctures, biopsies, infusions, surgeries, with who performed it, where, and the stated result.
- vital: each measured vital sign.
- allergy_intolerance: every allergy, intolerance, adverse reaction, or "do not give" instruction.
- clinician_statement: every opinion or position a clinician or institution takes about a treatment, diagnosis, or plan. Record who said it, their institution if named, what it is about, and the stance: supports, opposes, uncertain, or neutral.
- recommendation: every suggestion that something be done (a test, a drug, a referral, a behaviour), who recommended it, what it targets, and whether the same document says it was acted on. Patient instructions and education written by the care team are clinical: extract their instructions.
- referral: every referral, placed or proposed, with the destination, specialty, who referred, reason, and status.
- follow_up: every promised, planned, or scheduled action with what, who owns it, and when it is due, as written. Include phrases like "will call with results", "repeat labs in 6 weeks", "to be scheduled".
- record_reference: every study, report, visit, letter, or result that the document mentions. Set present_in_this_document to true only when the referenced record itself is reproduced in full here (for example the complete lab table or the full imaging report), and false when it is merely mentioned, summarised, or quoted in part. This is how missing records are found, so do not skip any.
- event: hospital admissions, ER visits, falls, relapses, and other dated happenings that do not fit above (never a messaging act).
- people_mentioned: for every fact, the clinician or institution names it involves, spelled as written.

Document-level fields
- document_title: a short, specific title for the whole document that says what it is and what it is about, with the author or institution and the date as written, for example "Neurology follow-up note, Dr. A. Example, 2024-03-11" or "Phone call with the clinic's nurse line about a medication question, 2030-07-16". Never a file name. When the message says the document is an institutional export (a chart print or health summary of many encounters), the title names the export as a whole (institution, kind of export, print date), not the part you are reading.
- document_summary: two or three plain sentences: what kind of document this is, who wrote it, which institution, when, and for what purpose.
- document_date: the date the document was written, signed, or issued, exactly as written, or null. For an institutional export, the date it was printed.
- document_category: the best fitting category, or null if unclear.
- institution and author: as written, or null.

Attribute key guide
${attributeKeyGuide()}

Return only the structured output. Do not add commentary.`;

export interface ChunkPage {
  pageNumber: number;
  text: string;
}

export interface UserMessageInput {
  title: string;
  category: string | null;
  totalPages: number;
  pages: ChunkPage[];
  documentDateText?: string | null;
  /** Where that date came from (`metadataJson.dateSource`): a file-name guess is labelled as one, not as the recorded date. */
  documentDateSource?: string | null;
  /** primary | patient | compilation | external | unknown: tells the model whose voice the document is in by default. */
  sourceTier?: string | null;
  /**
   * Lab lines the app's lab check found on these pages that no detail holds yet (2026-10-08): named so each becomes its
   * own lab_result fact. Only in the user message (the system prompt is unchanged).
   */
  mustInclude?: ReadonlyArray<{ page: number; text: string }>;
  /** The call holds lab result tables (a lab results part, or a part the lab check found many lab lines in). */
  labTables?: boolean;
}

/**
 * The rule for result tables, in the user message of every call that holds them (2026-10-09, lab recall: the first
 * reading of a long summary dropped most rows of dense result tables, e.g. a panel of limits printed as "<5.0").
 */
export const LAB_TABLE_RULE =
  'Lab result tables: every printed result row of a result table is its own lab_result fact: each value, each limit ("<5.0", ">1700"), each result in words ("Negative", "Clear"), each component of a panel (every cytokine, every cell count, every antibody). Never summarise a table, and never skip a row because it is normal, below a limit, or like the rows around it. One result printed again (under its parent or reflex order, or on another page) is still one fact citing each printing.';

function labTableBlock(on: boolean | undefined): string {
  return on ? `${LAB_TABLE_RULE}\n\n` : '';
}

/** The lines the lab check found missing, as a block of the user message (empty when there are none). */
export function mustIncludeBlock(rows: ReadonlyArray<{ page: number; text: string }> | undefined): string {
  if (!rows?.length) return '';
  const lines = rows.slice(0, 400).map((r) => `- page ${r.page}: ${r.text.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
  return [
    `Lab lines to report: a check of these pages found ${lines.length === 1 ? 'the lab result line' : `the ${lines.length} lab result lines`} below printed on them with no fact for them yet. Each line is printed on the page named: report each as a lab_result fact (test name, value, unit, range, flag and dates exactly as printed, under the usual rules), citing the line on its page; a result printed on several of these pages is one fact citing each printing. Report everything else on the pages as usual.`,
    ...lines,
    '',
    '',
  ].join('\n');
}

const TIER_HINT: Record<string, string> = {
  primary: 'a primary clinical document (what the institution recorded; assume the clinician is speaking unless the text is clearly the patient\'s own words)',
  patient: 'written by the patient or their chief of staff (assume the patient is speaking: asserted_by patient for first-person statements)',
  compilation: 'a compilation, summary or analysis assembled from other records (asserted_by compiler, except corrections in the patient\'s own voice, which are patient)',
  external: 'a letter from an insurer, employer, advocate or school (asserted_by unknown unless a clinician or the patient is clearly quoted)',
};

/**
 * How the document date is introduced to the model. A date read from the file
 * name is often the download or scan date, so it is offered as a guess the
 * pages may contradict; a date from the text, the file header, an earlier
 * model pass or the user is the date recorded for the document.
 */
export function documentDateLine(text: string | null | undefined, source: string | null | undefined, recordedLabel: string): string | null {
  const t = text?.trim();
  if (!t) return null;
  if (source === 'filename') return `Document date guessed from the file name: ${t} (often the download or scan date; the pages decide)`;
  return `${recordedLabel}: ${t}${source === 'user' ? ' (set by the user)' : ''}`;
}

/** Each page is a block that starts with "=== PAGE n ===" and then the page text. */
export function formatPageBlock(page: ChunkPage): string {
  return `=== PAGE ${page.pageNumber} ===\n${page.text.replace(/\r\n?/g, '\n').trimEnd()}\n`;
}

/** The single-part message (a document read as one block of pages, as before parts existed). */
export function buildExtractionUserMessage(input: UserMessageInput): string {
  const first = input.pages[0]?.pageNumber ?? 1;
  const last = input.pages[input.pages.length - 1]?.pageNumber ?? first;
  const header = [
    `Document title: ${input.title || '(untitled)'}`,
    `Category hint: ${input.category && input.category !== 'other' ? input.category : 'unknown'}`,
    input.sourceTier && TIER_HINT[input.sourceTier] ? `Source tier: ${input.sourceTier}, ${TIER_HINT[input.sourceTier]}` : null,
    documentDateLine(input.documentDateText, input.documentDateSource, 'Document date as recorded'),
    `This chunk: pages ${first}-${last} of ${input.totalPages}`,
    '',
    'Extract every fact from the pages below. Cite page numbers from the markers.',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
  return header + labTableBlock(input.labTables) + mustIncludeBlock(input.mustInclude) + input.pages.map(formatPageBlock).join('\n');
}

// ---------------------------------------------------------------------------
// Parts (segments): route hints per kind and tier
// ---------------------------------------------------------------------------

/** What each segment kind is, in the words the part line uses. */
export const PART_KIND_LABEL: Record<string, string> = {
  patient_summary: 'Patient summary',
  facesheet: 'Facesheet',
  visit_info: 'Visit information',
  note: 'Clinical note',
  telephone: 'Telephone encounter notes',
  messages: 'Portal messages',
  letter: 'Letters',
  questionnaire: 'Questionnaire',
  appointment_request: 'Appointment messages',
  patient_entered: 'Data entered by the patient',
  lab_results: 'Lab results',
  imaging: 'Imaging',
  orders: 'Orders',
  medication_list: 'Medication list',
  mar: 'Medication administration record',
  flowsheets: 'Flowsheets',
  vitals: 'Vital signs',
  procedures: 'Procedures',
  therapy_plan: 'Therapy plan',
  care_plan: 'Care plan',
  history: 'History',
  instructions: 'Patient instructions',
  education: 'Patient education',
  media: 'Scanned media',
  boilerplate: 'Repeated boilerplate',
  pages: 'Pages',
  other: 'Other content',
};

/**
 * The hint line for a segment kind: what to read in it and whose voice it is in. Kinds without a hint (a block of
 * pages of an unknown layout) say nothing more than the document's own tier line.
 */
export const PART_KIND_HINT: Record<string, string> = {
  patient_summary: 'Demographics, problem list, medications, allergies, immunizations and history as the institution lists them.',
  facesheet: 'Demographics and coverage as the institution lists them; extract only clinical facts (problems, allergies, care team).',
  visit_info: 'Visit details: who saw the patient, where and when.',
  note: 'A clinician\'s note. Lab values it restates are "as reported in the note" (see the rules).',
  telephone: 'Calls recorded by the care team (clinician voice). What the patient said on the call as written by staff is the clinician recording it. A call made by staff to a pharmacy, infusion centre or another clinic is the care team\'s action. The calls themselves are not facts.',
  messages: 'Portal messages printed in the record. Each message is in its sender\'s voice: "Sent" from the patient is the patient\'s own words (asserted_by patient); "Sent and Delivered" is from the care team. The act of messaging is not a fact; what a message says is.',
  letter: 'Letters sent by the institution. Extract what they state; the sending is not a fact.',
  questionnaire: 'Answers the patient submitted: the patient\'s own words (asserted_by patient). The submission is not a fact.',
  appointment_request: 'Appointment messages: "Patient comments" are the patient\'s own words (asserted_by patient). Scheduling or cancelling is not a fact.',
  patient_entered: 'Data the patient entered: the patient\'s own words (asserted_by patient).',
  lab_results: 'Lab results with their collection and result dates and times as printed. Every printed result row is its own lab_result fact, each component of a panel included. A result printed again under its parent or reflex order is the same result.',
  imaging: 'Imaging reports and orders.',
  orders: 'Orders: what was ordered, by whom and when, as printed. An order is not a result.',
  medication_list: 'A medication list: each drug as listed; the list date is not a start date.',
  mar: 'Doses given: each administration as recorded.',
  flowsheets: 'Measurements recorded over time.',
  vitals: 'Vital signs as measured.',
  procedures: 'Procedures performed, by whom and with what result.',
  therapy_plan: 'A treatment plan as written.',
  care_plan: 'A care plan as written.',
  history: 'History as recorded.',
  instructions: 'Instructions written by the care team for the patient: clinical, extract them.',
  education: 'Teaching given by the care team: clinical, extract what it says was taught or advised.',
  media: 'Scanned pages; the text may be OCR with noise. Cite it exactly as it reads.',
};

/** Whose voice a segment is in when it has its own tier (an outside letter scanned into the record, the patient's own pages). */
const PART_TIER_HINT: Record<string, string> = {
  patient: 'Voice: the patient\'s own words (asserted_by patient).',
  external: 'Voice: an outside party (asserted_by unknown unless a clinician or the patient is clearly quoted).',
  compilation: 'Voice: a compilation restating other records (asserted_by compiler).',
  primary: 'Voice: the institution\'s record (clinician).',
};

export interface PartInput {
  /** The segment's kind (SEGMENT_KINDS). */
  kind: string;
  /** The encounter banner or section heading as printed, if any. */
  headerText?: string | null;
  encounterDateText?: string | null;
  encounterType?: string | null;
  department?: string | null;
  /** The section and item headings as printed. */
  section?: string | null;
  item?: string | null;
  /** The segment's own tier when it differs from the document's. */
  sourceTier?: string | null;
  /** The pages of the segment as a whole (a long segment is read in several calls). */
  segmentPages: [number, number];
  /** "pages 4-9 of this part's 1-14" when the segment is read in several calls. */
  continued?: { from: number; to: number } | null;
  pages: ChunkPage[];
}

export interface PartsMessageInput extends Omit<UserMessageInput, 'pages'> {
  parts: PartInput[];
  /** An institutional export (an Epic chart print, a health summary): the document fields name the export as a whole. */
  exportLayout?: string | null;
}

function oneLine(s: string | null | undefined, max = 300): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The part line and its context lines. */
export function formatPartHeader(part: PartInput, k: number): string {
  const label = PART_KIND_LABEL[part.kind] ?? 'Other content';
  const [a, b] = part.segmentPages;
  const lines = [`=== PART ${k}: ${label}, pages ${a === b ? a : `${a}-${b}`} ===`];
  const header = oneLine(part.headerText);
  if (header) lines.push(`Encounter as printed: ${header}`);
  else {
    const bits = [oneLine(part.encounterDateText), oneLine(part.encounterType), part.department ? `in ${oneLine(part.department)}` : ''].filter(Boolean);
    if (bits.length) lines.push(`Encounter: ${bits.join(' ')}`);
  }
  const section = [oneLine(part.section, 160), oneLine(part.item, 160)].filter(Boolean).join(' / ');
  if (section) lines.push(`Section: ${section}`);
  if (part.continued) lines.push(`This call reads pages ${part.continued.from}-${part.continued.to} of this part; the rest is read in another call.`);
  const hint = PART_KIND_HINT[part.kind];
  if (hint) lines.push(`About this part: ${hint}`);
  const tierHint = part.sourceTier ? PART_TIER_HINT[part.sourceTier] : undefined;
  if (tierHint) lines.push(tierHint);
  return `${lines.join('\n')}\n`;
}

/** The message for one call over one or more parts. */
export function buildPartsUserMessage(input: PartsMessageInput): string {
  const pages = input.parts.flatMap((p) => p.pages.map((pg) => pg.pageNumber));
  const first = pages.length ? Math.min(...pages) : 1;
  const last = pages.length ? Math.max(...pages) : first;
  const header = [
    `Document title: ${input.title || '(untitled)'}`,
    `Category hint: ${input.category && input.category !== 'other' ? input.category : 'unknown'}`,
    input.sourceTier && TIER_HINT[input.sourceTier] ? `Source tier: ${input.sourceTier}, ${TIER_HINT[input.sourceTier]}` : null,
    input.exportLayout
      ? `This document is an institutional export (${input.exportLayout.replace(/_/g, ' ')}) of ${input.totalPages} pages and many encounters: the document fields describe the export as a whole, not this part.`
      : null,
    documentDateLine(input.documentDateText, input.documentDateSource, 'Document date as recorded'),
    `This call: ${input.parts.length} part${input.parts.length === 1 ? '' : 's'}, pages ${first}-${last} of ${input.totalPages}`,
    '',
    'Extract every fact from the parts below. Cite page numbers from the page markers.',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
  const body = input.parts.map((p, i) => `${formatPartHeader(p, i + 1)}\n${p.pages.map(formatPageBlock).join('\n')}`).join('\n');
  return header + labTableBlock(input.labTables) + mustIncludeBlock(input.mustInclude) + body;
}
