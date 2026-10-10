/**
 * Tools the consult can call. All read the case except propose_refile, which
 * only records a proposal the patient approves or declines in the thread. Every tool returns plain text with
 * provenance tokens (⟦F:id⟧, ⟦C:id⟧, ⟦D:id p.N⟧) so the answer can cite what
 * the tool found. Definitions are strict JSON schemas (every property listed
 * in `required`, nullable where optional, additionalProperties false); inputs
 * are re-validated with zod before running.
 *
 * Lab series and charts come from services/labs.ts (slice I): lab_results
 * rows merged with unimported lab_result facts, synonyms resolved there.
 */
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db';
import { medicationTimelineText } from './med-timeline';
import { searchAll, ftsQuery, type SearchHit } from './search';
import { listTimeline } from './timeline';
import { listCommunications } from './communications';
import { getPages, listDocuments } from './documents';
import {
  LAB_ROW_FORMAT,
  attachCopyNotes,
  attachRecordCites,
  checkNote,
  communicationNoteBits,
  dailyLogBits,
  documentNoteBits,
  editedMarker,
  encounterNoteBits,
  factLine,
  factNoteBit,
  findingNoteBit,
  findingTaskTexts,
  fmtDate,
  followUpBit,
  followUpState,
  imagingNoteBits,
  labNoteBits,
  labRowLine,
  liveFactIds,
  loadFactTexts,
  loadLedgerFacts,
  loadPeople,
  medEventDetailBit,
  medicationNoteBits,
  overrideMarker,
  partialDateInWindow,
  setAsideLabNotes,
  sourceTexts,
  taskDetailBit,
  trustMarkers,
  tokC,
  tokD,
  tokF,
  userNote,
  type LabRow,
} from './ask-context';
import { parseJson } from '../util/ids';
import { todayIso } from '../../shared/dates';
import { findLabSeries as labsFindLabSeries, buildLabChart as labsBuildLabChart, analyteLabel, isWordOnly, lineFactStatus, listAnalytes, loadLabEntries, matchLabAnalyte, type LabEntry } from './labs';
import { normalizeKey } from '../util/ids';
import { chartSpec, type ChartSpec } from '../../shared/chart';
import { unitKey } from '../../shared/labvalues';
import { FACT_STATUSES, FACT_TYPES, DOCUMENT_CATEGORIES, SPECIMENS } from '../../shared/enums';
import { TIMELINE_KINDS, isTimelineKind, type TimelineKind } from '../../shared/timeline';
import { proposeMove } from './filing';
import { trustFor, trustForRows } from './reconcile';
import {
  COMMUNICATIONS_LEGEND,
  MESSAGE_LEDGER_CHARS,
  VOICE_WORDS,
  communicationBits,
  communicationSourceBit,
  coverageOfMetadata,
  extractionWords,
  isFromRecord,
  localStamp,
  messageAuthorBit,
  messagePage,
  pagesInState,
  readingWords,
  sortCommunications,
  askComputedOf,
} from './ask-context';
import { proposeComputedValue } from './lab-compute';
import { FORMULAS, FORMULA_IDS, type FormulaId } from '../../shared/labcompute';
import { documentOutline, readUploadRecord, uploadConfirmation } from './segments';
import { currentCoverage, estimateRemaining, requestReprocess } from './reprocess';
import { getThread } from './threads';
import { proposeMoves } from './filing-batch';
import { formatBytes, formatPageRanges, ingestionReport, normalizeForHash, parseCommunicationDetails, parseExportInfo, type DocumentCoverage, type IngestionReport, type ReprocessResult } from '../../shared/schemas/segments';
import { visualPageText } from '../ingest/reflow';
import { zodIssues } from '../util/errors';
import type { AskLabValue } from '../../shared/ask';
import { addLabValueFromPage, proposeLabValueFromPage } from './lab-check';
import { labCheckWords, parseLabCheckReport, type LabCheckReport } from '../../shared/labcheck';
import { planForClinician } from './plans';

// ---------------------------------------------------------------------------
// JSON schema helpers (strict mode: all properties required, nullable optionals)
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

const str = (description: string): JsonSchema => ({ type: 'string', description });
const nstr = (description: string): JsonSchema => ({ type: ['string', 'null'], description });
const nint = (description: string): JsonSchema => ({ type: ['integer', 'null'], description });
const nnum = (description: string): JsonSchema => ({ type: ['number', 'null'], description });
const nbool = (description: string): JsonSchema => ({ type: ['boolean', 'null'], description });
// The API rejects `enum` combined with a union `type` (["string","null"]), so a nullable enum is an anyOf.
const nenum = (values: readonly string[], description: string): JsonSchema => ({ anyOf: [{ type: 'string', enum: [...values] }, { type: 'null' }], description });
const narr = (items: JsonSchema, description: string): JsonSchema => ({ type: ['array', 'null'], items, description });
const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const nobj = (properties: Record<string, JsonSchema>, description: string): JsonSchema => ({ type: ['object', 'null'], properties, required: Object.keys(properties), additionalProperties: false, description });

function tool(name: string, description: string, properties: Record<string, JsonSchema>): Anthropic.Tool {
  return {
    name,
    description,
    // Not strict: the API caps strict tool schemas at 16 union-typed parameters per request; inputs are validated server-side with zod instead.
    input_schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
  };
}

const DATE_DESC = 'YYYY, YYYY-MM or YYYY-MM-DD, or null';
const HIT_TYPES = ['document', 'page', 'fact', 'person', 'communication', 'record', 'task', 'finding', 'encounter', 'medication', 'lab', 'imaging', 'intolerance'] as const;

const CHART_X: JsonSchema = { type: ['string', 'number'], description: 'ISO date (YYYY, YYYY-MM or YYYY-MM-DD), a number, or a category label' };
const CHART_TONES = ['accent', 'warn', 'bad', 'ok', 'ash', 'info'] as const;

const chartSpecSchema: Record<string, JsonSchema> = {
  type: { type: 'string', enum: ['line', 'bar', 'scatter'], description: 'Chart type' },
  title: nstr('Short title'),
  subtitle: nstr('Optional subtitle'),
  xType: { type: 'string', enum: ['date', 'number', 'category'], description: 'What the x values are' },
  xLabel: nstr('x axis label'),
  yLabel: nstr('y axis label, usually the unit'),
  series: {
    type: 'array',
    description: 'One to eight series',
    items: obj({
      name: str('Series name, e.g. the analyte'),
      unit: nstr('Unit'),
      kind: nenum(['line', 'bar', 'scatter'], 'Per-series override of the chart type'),
      points: {
        type: 'array',
        description: 'Points in x order',
        items: obj({
          x: CHART_X,
          y: nnum('Value; null leaves a gap'),
          label: nstr('Optional point label, e.g. a non-numeric value as written'),
          flag: nstr('H, L, A or C when out of range'),
          href: nstr('Link to the source page, e.g. /documents/<documentId>?page=3'),
        }),
      },
    }),
  },
  referenceBand: nobj({ low: nnum('Lower reference limit'), high: nnum('Upper reference limit'), label: nstr('Label') }, 'Reference range to shade'),
  yDomain: { type: ['array', 'null'], items: { type: 'number' }, description: 'Fixed [min, max] for the y axis, or null for automatic' },
  bands: narr(obj({ from: CHART_X, to: { type: ['string', 'number', 'null'], description: 'End, or null for open-ended' }, label: str('Label'), tone: nenum(CHART_TONES, 'Colour tone') }), 'Shaded periods, e.g. a medication course'),
  markers: narr(obj({ x: CHART_X, label: str('Label'), tone: nenum(CHART_TONES, 'Colour tone') }), 'Vertical event ticks'),
  note: nstr('A footnote shown under the chart, e.g. where the values came from'),
};

export const ASK_TOOLS: Anthropic.Tool[] = [
  tool('search_case', 'Full-text search over the whole case: facts, document pages, communications, people, records, tasks, findings, encounters, medications, labs, imaging. Returns matching items with provenance tokens. Use for "where is X mentioned" questions.', {
    query: str('Search words. Every word must appear (prefix matched).'),
    types: narr({ type: 'string', enum: [...HIT_TYPES] }, 'Restrict to these item types, or null for all'),
    limit: nint('Maximum items (default 40, max 200)'),
  }),
  tool('get_facts', 'List extracted facts with their status and provenance. Filter by type, subject words, date range, status or source document. Returns compact lines ending in ⟦F:factId⟧.', {
    type: nenum(FACT_TYPES, 'Fact type, or null for any'),
    subject: nstr('Words that must appear in the fact (matched against the subject key and the statement), or null'),
    from: nstr(DATE_DESC),
    to: nstr(DATE_DESC),
    status: nenum(FACT_STATUSES, 'Fact status, or null for any non-superseded'),
    documentId: nstr('Restrict to facts from this document id, or null'),
    limit: nint('Maximum facts (default 100, max 500)'),
  }),
  tool('get_lab_series', 'Every stored result for one analyte, chronological, merged from lab result rows and lab facts. Matched by the exact test name or a known spelling of the same test ("CSF/serum albumin ratio" is the albumin index); similar names of different tests are never merged: an unclear name ("IgG", "albumin") returns no rows and names the similar tests on file (IgG index, CSF IgG, serum IgG), and one asks again by one of those names. Returns rows: date | value as printed, unit | ref: range as printed | flag as printed (and the flag worked out from that range) | [status] | ⟦D:documentId p.N⟧ ⟦F:factId⟧.', {
    analyte: str('Analyte name, e.g. "albumin index", "CSF protein", "IgG index"'),
    specimen: nenum([...SPECIMENS, 'any'], 'Specimen filter, or null for any'),
    from: nstr(DATE_DESC),
    to: nstr(DATE_DESC),
  }),
  tool('get_document_pages', 'Read the text of pages of one document (up to 20 pages per call). Pages are marked "=== PAGE n ===" and each carries its ⟦D:documentId p.n⟧ token.', {
    documentId: str('Document id'),
    from: nint('First page (default 1)'),
    to: nint('Last page (default from + 19)'),
  }),
  tool('get_timeline', 'The chronology of everything dated between two dates: documents, facts, communications, encounters, medication events, labs, imaging, symptom days, tasks, findings.', {
    from: str(DATE_DESC.replace(', or null', '')),
    to: str(DATE_DESC.replace(', or null', '')),
    kinds: narr({ type: 'string', enum: [...TIMELINE_KINDS] }, 'Restrict to these kinds, or null for all'),
    q: nstr('Words that must appear in the title, the detail, or a note written on the item (check notes, visit prep and outcomes, contact outcomes and follow-ups, lab, imaging and task notes), or null'),
  }),
  tool('get_communications', 'Contact events (portal messages, calls, emails, visits, letters) with participants, topics, outcomes and promised follow-ups: the ones logged by the patient or his team, and the messages, telephone notes, letters and questionnaires read word for word out of records (each with whose words it is and its real page ⟦D:id p.N⟧). Lines end in ⟦C:communicationId⟧; a "thread <key>" goes to get_thread.', {
    personId: nstr('Restrict to communications involving this person id, or null'),
    topic: nstr('Topic tag, or null'),
    from: nstr(DATE_DESC),
    to: nstr(DATE_DESC),
    q: nstr('Words to match in subject, summary, outcome, topics or participant names, or null'),
  }),
  tool('list_documents', 'The documents on file: id, date, title, category, pages, institution, how many details, and how much of each was read ("partly read: details from pp.1-48 of 1,840; 1,792 not read; 214 scanned pages"). Use the ids with get_document_pages, get_document_coverage and get_document_outline.', {
    q: nstr('Words to match in the title, filename, notes, tags or page text, or null'),
    category: nenum(DOCUMENT_CATEGORIES, 'Category, or null for all'),
    from: nstr(DATE_DESC),
    to: nstr(DATE_DESC),
  }),
  tool('chart_lab_series', 'Build a chart of one analyte over time from stored results (same exact matching as get_lab_series: similar names of different tests are never merged; an unclear name returns no chart and names the similar tests on file), each point linked to its source page; the normal range is shaded only when every value in view printed the same one (else the note names each range with its lab). Optionally overlay medication courses as shaded periods. Returns "Chart N: ..." — refer to it in the answer as [chart:N]; values in several units give one chart per unit (nothing converted or relabelled), each its own [chart:N]. Only measurements are drawn: a limit ("<3") is never drawn as a number, and a test whose results are all words or limits (Negative, Clear, "<2") gets no chart; the tool answers with its dated results in words instead (no [chart:N] then).', {
    analyte: str('Analyte name'),
    specimen: nenum([...SPECIMENS, 'any'], 'Specimen filter, or null for any'),
    from: nstr(DATE_DESC),
    to: nstr(DATE_DESC),
    overlayMedications: nbool('Shade medication courses behind the series'),
    title: nstr('Chart title, or null for the default'),
  }),
  tool('make_chart', 'Render a chart from series you assembled yourself from retrieved text (when the values are not stored as lab results). Every value must come from the materials; cite them in the answer. The chart is labelled as model-assembled. Returns "Chart N: ..." — refer to it as [chart:N].', chartSpecSchema),
  tool('propose_refile', 'Propose moving a document to the type it should have, when the materials show it is filed under the wrong one. Nothing changes until the patient approves the proposal in the thread. Returns a confirmation line or the reason it was refused.', {
    documentId: str('Id of the document to move (from list_documents or a ⟦D:…⟧ token)'),
    toCategory: { type: 'string', enum: [...DOCUMENT_CATEGORIES], description: 'The type the document should have' },
    reason: str('One sentence the patient will read: why this type fits better, citing what the document shows'),
  }),
  tool('get_document_coverage', 'How completely one document was uploaded and read: whether every page of the file arrived and was stored, which pages Claude read (details pulled out), which were read word for word without the model (messages, notes, letters), skipped (repeats, blank) or could not be read (with the reason), which are not read yet, scanned pages and OCR, whether reading the rest waits for the patient\'s go-ahead and what it would cost, and what the last reading found (messages, threads, people, gaps closed, trust markers, medications, findings). Read-only.', {
    documentId: str('Document id'),
  }),
  tool('get_document_outline', 'The outline of a long document such as a hospital chart print: one line per visit or block (pages, date, type and department as printed, encounter number when printed, whether it was read, details and messages found), optionally with its parts (notes, messages, lab results, orders, media...). Use it to find the pages of a visit before get_document_pages.', {
    documentId: str('Document id'),
    fromPage: nint('Only entries that end on or after this page, or null'),
    toPage: nint('Only entries that start on or before this page, or null'),
    parts: nbool('true lists each entry\'s parts too (kind, pages, read or not); null or false gives one line per entry'),
  }),
  tool('get_thread', 'One conversation read out of the records (portal messages and their replies, with telephone notes kept apart), oldest first, every message in full and word for word: date and time as printed, who wrote it and whose words it is (the patient\'s own words or the care team\'s), to whom (often a nurse pool supporting a clinician), read receipts, its pages ⟦D:id p.N⟧, and filed copies of it. Give the thread key from a "thread <key>" on a communications line, or a ⟦C:…⟧ id.', {
    threadKey: nstr('The thread key (starts with t1_), or null'),
    communicationId: nstr('A communication id from a ⟦C:…⟧ token, or null'),
  }),
  tool('propose_reprocess_many', 'Have Claude read documents (again): the pages not read yet (missing), only the parts that could not be read (failed), every page again (whole, keeping everything the patient checked), or given pages (pages: read again even when they were read before, for example a page whose lab lines the lab check found missing; nothing is copied, and what the patient checked is kept). When the patient asked for exactly this in his message, quote his words in askedInMessage: it runs at once, as many documents as he asked for, and anything costing more than his limit waits for one yes. Otherwise (askedInMessage null) it is only a proposal he approves in the thread, and at most five documents may be proposed unasked in one answer. Returns what was started, what waits and why.', {
    documentIds: { type: 'array', items: { type: 'string' }, description: 'Document ids (from list_documents or ⟦D:…⟧ tokens), 1 to 500' },
    scope: { type: 'string', enum: ['missing', 'failed', 'whole', 'pages'], description: 'missing (default for a partly read document), failed, whole or pages' },
    pages: narr({ type: 'array', items: { type: 'integer' }, description: '[first, last]' }, 'With scope pages: the page ranges to read again, e.g. [[49, 72]]; else null'),
    deep: nbool('true reads with the deeper model (about twice the cost); null or false for the everyday model'),
    reason: str('One sentence the patient will read: why these documents should be read'),
    askedInMessage: nstr("The patient's own words from his message asking for this, quoted exactly; null when you propose it unasked"),
  }),
  tool('propose_refile_many', 'Move several documents to the types they should have, in one batch. When the patient asked for exactly these moves in his message, quote his words in askedInMessage: they are made at once, as many as he asked for, each with Undo. Otherwise (askedInMessage null) they wait for his one "Approve all" in the thread, and at most five documents may be proposed unasked in one answer.', {
    items: {
      type: 'array',
      description: 'The moves, 1 to 500',
      items: obj({
        documentId: str('Id of the document to move'),
        toCategory: { type: 'string', enum: [...DOCUMENT_CATEGORIES], description: 'The type it should have' },
        reason: str('One sentence the patient will read: why this type fits, citing what the document shows'),
      }),
    },
    askedInMessage: nstr("The patient's own words from his message asking for these moves, quoted exactly; null when you propose them unasked"),
  }),
  tool('add_lab_value_from_page', 'Put a lab result printed on a page into the lab table (Labs) when no stored value holds it: get_lab_series does not list it, or get_document_coverage names it among the lab lines the lab check found missing. Give the document, the page and the line as printed on that page (as get_document_pages shows it, cells separated by " | "), or a quote of it. The app checks that the line is on that page, reads it with its own parser (value, unit, range and flag exactly as printed; the collected and resulted dates and the performing lab only when the page prints them), refuses a line that is not a lab result or is unclear (say which test with analyte when the line holds several), and never makes a second copy of a value already on file. When the patient asked for this in his message (for example "Can you add it to the table?"), quote his words in askedInMessage: it is added at once, with Undo under the answer. Otherwise (askedInMessage null) it is only a proposal he approves in the thread with one press. Returns what was added or proposed, or why it was refused.', {
    documentId: str('Document id (from list_documents or a ⟦D:…⟧ token)'),
    page: { type: 'integer', description: 'The page the line is printed on' },
    row: nstr('The line as printed on that page, e.g. "Albumin Index | 7.6 | 0.0 - 9.0 ratio"; or null when you give a quote'),
    quote: nstr('Words quoted from the line on that page, or null when you give the row'),
    analyte: nstr('Which test, when the line holds several; else null'),
    reason: str('One sentence the patient will read: why this value belongs in the table (e.g. no stored value holds it)'),
    askedInMessage: nstr("The patient's own words from his message asking for this, quoted exactly; null when you propose it unasked"),
  }),
  tool('propose_computed_value', 'Propose computing a value from values printed on lab reports, when the lab did not print it: the albumin index (formula albumin_index: inputs csf_albumin and serum_albumin), the IgG index (igg_index: csf_igg, serum_igg, csf_albumin, serum_albumin) or a general ratio (ratio: inputs a and b, with k, the unit and a name). Name each input by the ⟦F:factId⟧ of a printed value from get_lab_series (with the analyte when that detail holds several tests). The app does the arithmetic itself: only values printed by a lab (never a summary, a typed or a computed value), units converted only by its fixed table, every input collected within 48 hours (a CSF and serum pair) or on one day; it refuses with the reason otherwise. It is ALWAYS only a proposal: nothing is computed until the patient presses yes under the answer, even when he asked for it. Counts as one of the five unasked proposals of an answer. Returns what was proposed (the result and its pages) or why it cannot be computed.', {
    formula: { type: 'string', enum: [...FORMULA_IDS], description: 'albumin_index, igg_index or ratio' },
    inputs: { type: 'array', description: 'One item per input of the formula', items: obj({ slot: str('The input: csf_albumin, serum_albumin, csf_igg, serum_igg, a or b'), factId: str('The printed value\'s fact id (from its ⟦F:…⟧ token)'), analyte: nstr('Which test, when that detail holds several; else null') }) },
    k: { type: ['number', 'null'], description: 'ratio only: the factor k (1 when nothing is multiplied); else null' },
    unit: nstr('ratio only: the unit of the result, or null'),
    name: nstr('ratio only: the name of the result (e.g. "CSF/serum glucose ratio"); else null'),
    reason: str('One sentence the patient will read: why this value is worth computing'),
  }),
  tool('get_current_plan', "Read-only. The patient's current plan (the Plan page): the plan document read into an outline of sections, goals, steps, checks, criteria, decision points with their branches, contacts and medications named in it, one line per item with who, when (as written), the condition, where his checklist stands (to do, done, skipped, doesn't apply, by whom and when), his edits beside the plan's wording, a linked to-do, and the plan document's page token ⟦D:id p.N⟧ for each item. It is what was planned, not a record of what happened: cite an item as the plan document by its token. Give a planId (listed under Other plans) to read an earlier, replaced plan.", {
    planId: nstr('The id of another plan (from "Other plans"), or null for the current plan'),
  }),
  tool('get_medication_timeline', "One drug's timeline as each source states it (read-only): one lane per clinical record and per note of the patient's own, with the start, stop and dated doses each gives and its ⟦F:…⟧ token; where the clinical records disagree (and how the patient settled it: one record right, both happened, a record wrong); the settled timeline with who said each date (\"per the patient's notes\" where his notes won over the records, the records' version beside it, kept as written); and each start, stop or dose of his notes set against the records (agrees, differs, waits for the records, nothing to compare) with his answer. Give the drug as written; a name that matches several drugs lists them.", {
    drug: str('The drug as written, e.g. "lisinopril"'),
  }),
];

// ---------------------------------------------------------------------------
// zod validation of tool inputs
// ---------------------------------------------------------------------------

const nz = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional();
const partialDate = nz(z.string().trim().max(32));

export const toolInputSchemas = {
  search_case: z.object({ query: z.string().trim().min(1).max(500), types: nz(z.array(z.enum(HIT_TYPES))), limit: nz(z.number().int().min(1).max(200)) }),
  get_facts: z.object({ type: nz(z.enum(FACT_TYPES)), subject: nz(z.string().max(300)), from: partialDate, to: partialDate, status: nz(z.enum(FACT_STATUSES)), documentId: nz(z.string().max(64)), limit: nz(z.number().int().min(1).max(500)) }),
  get_lab_series: z.object({ analyte: z.string().trim().min(1).max(200), specimen: nz(z.string().max(32)), from: partialDate, to: partialDate }),
  get_document_pages: z.object({ documentId: z.string().min(1).max(64), from: nz(z.number().int().min(1)), to: nz(z.number().int().min(1)) }),
  get_timeline: z.object({ from: z.string().trim().max(32), to: z.string().trim().max(32), kinds: nz(z.array(z.string())), q: nz(z.string().max(300)) }),
  get_communications: z.object({ personId: nz(z.string().max(64)), topic: nz(z.string().max(120)), from: partialDate, to: partialDate, q: nz(z.string().max(300)) }),
  list_documents: z.object({ q: nz(z.string().max(300)), category: nz(z.enum(DOCUMENT_CATEGORIES)), from: partialDate, to: partialDate }),
  chart_lab_series: z.object({ analyte: z.string().trim().min(1).max(200), specimen: nz(z.string().max(32)), from: partialDate, to: partialDate, overlayMedications: nz(z.boolean()), title: nz(z.string().max(200)) }),
  make_chart: z.object({}).passthrough(),
  propose_refile: z.object({ documentId: z.string().trim().min(1).max(64), toCategory: z.enum(DOCUMENT_CATEGORIES), reason: z.string().trim().min(1).max(600) }),
  get_document_coverage: z.object({ documentId: z.string().trim().min(1).max(64) }),
  get_document_outline: z.object({ documentId: z.string().trim().min(1).max(64), fromPage: nz(z.number().int().min(1)), toPage: nz(z.number().int().min(1)), parts: nz(z.boolean()) }),
  get_thread: z
    .object({ threadKey: nz(z.string().trim().max(120)), communicationId: nz(z.string().trim().max(64)) })
    .refine((v) => Boolean(v.threadKey?.trim() || v.communicationId?.trim()), { message: 'give a threadKey or a communicationId' }),
  propose_reprocess_many: z.object({
    documentIds: z.array(z.string().trim().min(1).max(64)).min(1).max(500),
    scope: nz(z.enum(['missing', 'failed', 'whole', 'pages'])),
    pages: nz(z.array(z.tuple([z.number().int().min(1), z.number().int().min(1)])).max(200)),
    deep: nz(z.boolean()),
    reason: z.string().trim().min(1).max(2000),
    askedInMessage: nz(z.string().max(2000)),
  }),
  propose_refile_many: z.object({
    items: z.array(z.object({ documentId: z.string().trim().min(1).max(64), toCategory: z.enum(DOCUMENT_CATEGORIES), reason: z.string().trim().min(1).max(2000) })).min(1).max(500),
    askedInMessage: nz(z.string().max(2000)),
  }),
  add_lab_value_from_page: z
    .object({
      documentId: z.string().trim().min(1).max(64),
      page: z.number().int().min(1),
      row: nz(z.string().max(2000)),
      quote: nz(z.string().max(2000)),
      analyte: nz(z.string().trim().max(200)),
      reason: nz(z.string().trim().max(2000)),
      askedInMessage: nz(z.string().max(2000)),
    })
    .refine((v) => Boolean(v.row?.trim() || v.quote?.trim()), { message: 'give the row as printed or a quote of it' }),
  propose_computed_value: z.object({
    formula: z.enum(FORMULA_IDS as unknown as [FormulaId, ...FormulaId[]]),
    inputs: z.array(z.object({ slot: z.string().trim().min(1).max(40), factId: z.string().trim().min(1).max(64), analyte: nz(z.string().trim().max(200)) })).min(1).max(4),
    k: nz(z.number().finite()),
    unit: nz(z.string().trim().max(40)),
    name: nz(z.string().trim().max(120)),
    reason: z.string().trim().min(1).max(2000),
  }),
  get_current_plan: z.object({ planId: nz(z.string().trim().max(64)) }),
  get_medication_timeline: z.object({ drug: z.string().trim().min(1).max(200) }),
} as const;

export type ToolName = keyof typeof toolInputSchemas;
export const TOOL_NAMES = Object.keys(toolInputSchemas) as ToolName[];

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface ToolContext {
  /** Charts produced so far in this answer; chart tools append and return the 1-based number. */
  charts: ChartSpec[];
  onChart?: (chart: ChartSpec, n: number) => void;
  /** The answer being written, so a proposed move links back to it. */
  askMessageId?: string | null;
  /** Filing ids of moves and reading requests made or proposed so far in this answer (shown under the answer). */
  proposals?: string[];
  /**
   * The patient's message this answer replies to. A bulk tool runs as his own request only when the words it quotes
   * (askedInMessage) are in it; otherwise it is the clinician's unasked proposal.
   */
  question?: string | null;
  /** Documents proposed unasked so far in this answer (moves, reading requests and lab values; at most MAX_PROPOSALS_PER_ANSWER). */
  unsolicited?: number;
  /** Lab values added at the patient's request in this answer (shown under it, each with Undo). */
  labValues?: AskLabValue[];
}

export interface ToolOutcome {
  text: string;
  isError: boolean;
  /** One line for the UI and the tool log, e.g. "get_lab_series: albumin index (csf)". */
  summary: string;
}

const MAX_TOOL_CHARS = 120_000;

/** Cut long output at the last line break within `max`, so a line that is kept keeps its notes whole. */
function cap(text: string, max = MAX_TOOL_CHARS): string {
  if (text.length <= max) return text;
  const lineEnd = text.lastIndexOf('\n', max);
  return `${text.slice(0, lineEnd > 0 ? lineEnd : max)}\n… (output truncated at ${max} characters; narrow the query)`;
}

export function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === 'string' && (i[k] as string).trim() ? (i[k] as string).trim() : null);
  switch (name) {
    case 'search_case':
      return `search_case: "${s('query') ?? ''}"`;
    case 'get_facts':
      return `get_facts: ${[s('type'), s('subject') ? `"${s('subject')}"` : null, s('status'), s('from') || s('to') ? `${s('from') ?? ''}…${s('to') ?? ''}` : null].filter(Boolean).join(' ') || 'all'}`;
    case 'get_lab_series':
    case 'chart_lab_series':
      return `${name}: ${s('analyte') ?? ''}${s('specimen') && s('specimen') !== 'any' ? ` (${s('specimen')})` : ''}${s('from') || s('to') ? ` ${s('from') ?? ''}…${s('to') ?? ''}` : ''}`;
    case 'get_document_pages':
      return `get_document_pages: ${s('documentId')?.slice(0, 8) ?? ''} p.${i.from ?? 1}${i.to ? `-${i.to}` : ''}`;
    case 'get_timeline':
      return `get_timeline: ${s('from') ?? ''}…${s('to') ?? ''}${s('q') ? ` "${s('q')}"` : ''}`;
    case 'get_communications':
      return `get_communications: ${[s('topic') ? `topic ${s('topic')}` : null, s('q') ? `"${s('q')}"` : null, s('from') || s('to') ? `${s('from') ?? ''}…${s('to') ?? ''}` : null].filter(Boolean).join(' ') || 'all'}`;
    case 'list_documents':
      return `list_documents: ${[s('q') ? `"${s('q')}"` : null, s('category')].filter(Boolean).join(' ') || 'all'}`;
    case 'make_chart':
      return `make_chart: ${s('title') ?? 'untitled'}`;
    case 'propose_refile':
      return `propose_refile: ${s('documentId') ?? ''} to ${s('toCategory') ?? ''}`;
    case 'get_document_coverage':
      return `get_document_coverage: ${s('documentId')?.slice(0, 8) ?? ''}`;
    case 'get_document_outline':
      return `get_document_outline: ${s('documentId')?.slice(0, 8) ?? ''}${i.fromPage || i.toPage ? ` p.${i.fromPage ?? 1}-${i.toPage ?? ''}` : ''}`;
    case 'get_thread':
      return `get_thread: ${(s('threadKey') ?? s('communicationId') ?? '').slice(0, 12)}`;
    case 'propose_reprocess_many': {
      const n = Array.isArray(i.documentIds) ? i.documentIds.length : 0;
      return `propose_reprocess_many: ${n} document${n === 1 ? '' : 's'}${s('scope') ? ` (${s('scope')})` : ''}${s('askedInMessage') ? ' asked' : ''}`;
    }
    case 'propose_refile_many': {
      const n = Array.isArray(i.items) ? i.items.length : 0;
      return `propose_refile_many: ${n} document${n === 1 ? '' : 's'}${s('askedInMessage') ? ' asked' : ''}`;
    }
    case 'propose_computed_value':
      return `propose_computed_value: ${s('formula') ?? ''}`;
    case 'add_lab_value_from_page':
      return `add_lab_value_from_page: ${s('documentId')?.slice(0, 8) ?? ''} p.${typeof i.page === 'number' ? i.page : '?'}${s('analyte') ? ` ${s('analyte')}` : ''}${s('askedInMessage') ? ' asked' : ''}`;
    case 'get_current_plan':
      return `get_current_plan${s('planId') ? `: ${s('planId')!.slice(0, 8)}` : ''}`;
    case 'get_medication_timeline':
      return `get_medication_timeline: ${s('drug') ?? ''}`;
    default:
      return name;
  }
}

/** Partial dates overlap the window at the coarser precision (a year-only date is kept by any window touching that year). */
function within(iso: string | null | undefined, from?: string | null, to?: string | null): boolean {
  return partialDateInWindow(iso, from?.trim() || null, to?.trim() || null);
}

/** Ids in chunks the SQLite parameter limit allows, deduplicated. */
function byIds<T>(ids: Array<string | null | undefined>, load: (part: string[]) => T[]): T[] {
  const want = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const out: T[] = [];
  for (let i = 0; i < want.length; i += 400) out.push(...load(want.slice(i, i + 400)));
  return out;
}

interface FactCheck {
  /** The trust marker(s), bracketed, same words as the ledger: [trust] then [the patient's answer] when he gave one. */
  marker: string;
  /** The note the patient or his team wrote when checking it. */
  note: string | null;
  overriddenBy: string | null;
  overrideReason: string | null;
  /** Source tier of the fact's document (null when it has none). */
  tier: string | null;
}

/**
 * Trust markers, check note and patient-precedence override of each of these facts. `linesNameDocument`: the
 * lines these markers go on name the fact's own document (the timeline's detail does); a search hit names none, so
 * there [verified] names its record.
 */
function factChecks(ids: Array<string | null | undefined>, linesNameDocument = true): Map<string, FactCheck> {
  const rows = byIds(ids, (part) =>
    db()
      .select({
        id: schema.facts.id,
        status: schema.facts.status,
        basis: schema.facts.verdictBasis,
        note: schema.facts.verdictNote,
        overriddenBy: schema.facts.overriddenByFactId,
        overrideReason: schema.facts.overrideReason,
        deletedAt: schema.facts.deletedAt,
        sourceDocumentId: schema.facts.sourceDocumentId,
        documentTier: schema.documents.sourceTier,
      })
      .from(schema.facts)
      .leftJoin(schema.documents, eq(schema.documents.id, schema.facts.sourceDocumentId))
      .where(inArray(schema.facts.id, part))
      .all(),
  );
  const trust = trustForRows(rows.map((r) => ({ id: r.id, status: r.status, verdictBasis: r.basis, verdictNote: r.note, documentTier: r.documentTier, deletedAt: r.deletedAt })));
  return new Map(rows.map((r) => [r.id, { marker: trustMarkers(trust.get(r.id), r.status, r.basis, linesNameDocument ? r.sourceDocumentId : null, r.documentTier), note: r.note, overriddenBy: r.overriddenBy, overrideReason: r.overrideReason, tier: r.documentTier }]));
}

/**
 * The trust markers of lab rows or imaging studies (by row id), from the detail each was made from: the same words
 * as the ledger's lab rows and study lines. A row typed by hand (no detail behind it) has none. A lab row is read as
 * the Labs page and the ledger read it (labs.ts loadLabEntries), never recomputed here: changed by hand away from its
 * detail (entry.editedFrom) it is the patient's value and reads [value changed by hand …], never its detail's trust; a
 * row standing for the record's value carries the record's trust; a row changed by hand to exactly the record's value
 * (entry.copyOf) reads as a copy of the record ([accurate: matches <record>]).
 */
function rowTrust(kind: 'lab' | 'imaging', ids: string[]): Map<string, string> {
  type RowCheck = { id: string; factId: string | null; documentId: string | null; status: string | null; basis: string | null; tier: string | null };
  const rows: RowCheck[] = byIds(ids, (part): RowCheck[] =>
    kind === 'lab'
      ? db()
          .select({ id: schema.labResults.id, factId: schema.labResults.factId, documentId: schema.labResults.documentId, status: schema.facts.status, basis: schema.facts.verdictBasis, tier: schema.documents.sourceTier })
          .from(schema.labResults)
          .leftJoin(schema.facts, eq(schema.facts.id, schema.labResults.factId))
          .leftJoin(schema.documents, eq(schema.documents.id, schema.facts.sourceDocumentId))
          .where(inArray(schema.labResults.id, part))
          .all()
      : db()
          .select({ id: schema.imagingStudies.id, factId: schema.imagingStudies.factId, documentId: schema.imagingStudies.documentId, status: schema.facts.status, basis: schema.facts.verdictBasis, tier: schema.documents.sourceTier })
          .from(schema.imagingStudies)
          .leftJoin(schema.facts, eq(schema.facts.id, schema.imagingStudies.factId))
          .leftJoin(schema.documents, eq(schema.documents.id, schema.facts.sourceDocumentId))
          .where(inArray(schema.imagingStudies.id, part))
          .all(),
  );
  const out = new Map<string, string>();
  if (!rows.length) return out;
  // A row whose line holds several tests is read as its parts: the first part speaks for the row's link and edits, and
  // the row's mark is its line's detail's trust (each part's own check is its test's, on the Labs page).
  const entries = kind === 'lab' ? new Map(loadLabEntries().filter((e) => e.source === 'row' && e.labResultId && (!e.splitFrom || e.splitFrom.index === 0)).map((e) => [e.labResultId as string, e])) : null;
  // The tier of a detail a row stands for that is not its own (the record a row stands in for), as the ledger reads it.
  const others = rows.map((r) => ({ r, e: entries?.get(r.id) })).filter((x) => x.e?.factId && x.e.factId !== x.r.factId).map((x) => x.e!.factId!);
  const tierOf = new Map(
    byIds(others, (part) =>
      db()
        .select({ id: schema.facts.id, tier: schema.documents.sourceTier })
        .from(schema.facts)
        .leftJoin(schema.documents, eq(schema.documents.id, schema.facts.sourceDocumentId))
        .where(inArray(schema.facts.id, part))
        .all(),
    ).map((x) => [x.id, x.tier ?? null] as const),
  );
  const lineFact = (r: RowCheck): string | null => {
    const e = entries?.get(r.id);
    return e?.factId ? (e.splitFrom ? e.factId : null) : r.factId;
  };
  const trust = trustFor(rows.map(lineFact).filter((x): x is string => Boolean(x)));
  for (const r of rows) {
    const e = entries?.get(r.id);
    if (e?.editedFrom) {
      out.set(r.id, editedMarker(e.editedFrom, e.editedFromRecord));
      continue;
    }
    if (e?.factId) {
      const t = e.splitFrom ? trust.get(e.factId) : e.trust;
      if (t) out.set(r.id, trustMarkers(t, lineFactStatus(e), e.factBasis, e.documentId ?? null, e.factId === r.factId ? (r.tier ?? null) : (tierOf.get(e.factId) ?? null)));
      continue;
    }
    // An imaging study, or a lab row whose detail was deleted: its own detail's trust.
    const t = r.factId ? trust.get(r.factId) : undefined;
    if (t) out.set(r.id, trustMarkers(t, r.status, r.basis, r.documentId ?? null, r.tier ?? null));
  }
  return out;
}

/** The note on the check of each of these facts, when the fact is still live (not deleted or superseded). */
function liveCheckNotes(ids: Array<string | null | undefined>): Map<string, string> {
  const rows = byIds(ids, (part) =>
    db()
      .select({ id: schema.facts.id, note: schema.facts.verdictNote })
      .from(schema.facts)
      .where(and(inArray(schema.facts.id, part), isNull(schema.facts.deletedAt), sql`${schema.facts.status} != 'superseded'`))
      .all(),
  );
  return new Map(rows.filter((r) => r.note?.trim()).map((r) => [r.id, r.note!]));
}

/** Item kinds whose notes the tools can look up: search hit types, timeline kinds, and the logs. */
type NoteKind = 'fact' | 'person' | 'communication' | 'record' | 'task' | 'finding' | 'encounter' | 'medication' | 'medication_event' | 'lab' | 'imaging' | 'intolerance' | 'document' | 'daily' | 'symptom';

/**
 * What the patient or his team wrote on each of these items, in the ledger's
 * words and markers (note (patient or team): "…" and its kin), in full up to
 * NOTE_MAX_CHARS per note. For communications, encounters, medication events,
 * daily log days and tasks the bits also carry the item's other detail, so a
 * tool can print them in place of a clipped detail. Symptom ids are dates.
 */
export function itemNotes(kind: NoteKind, ids: string[]): Map<string, string[]> {
  const d = db();
  const out = new Map<string, string[]>();
  const put = (id: string, bits: Array<string | null | undefined>) => {
    const b = bits.filter((x): x is string => Boolean(x));
    if (b.length) out.set(id, b);
  };
  switch (kind) {
    case 'fact': {
      const checks = factChecks(ids);
      const live = liveFactIds([...checks.values()].map((c) => c.overriddenBy));
      for (const [id, c] of checks) {
        // The override reason is the app's or the rule's wording (or a reason given when setting it by hand), printed unmarked as the ledger prints it.
        const override = c.overriddenBy && live.has(c.overriddenBy) ? overrideMarker({ overriddenByFactId: c.overriddenBy, overrideReason: c.overrideReason, overrideLive: true }).trim() : null;
        put(id, [factNoteBit(c.note), override]);
      }
      break;
    }
    case 'person':
      for (const r of byIds(ids, (p) => d.select({ id: schema.people.id, notes: schema.people.notes }).from(schema.people).where(inArray(schema.people.id, p)).all())) put(r.id, [userNote(r.notes)]);
      break;
    case 'communication': {
      const rows = byIds(ids, (p) => d.select().from(schema.communications).where(inArray(schema.communications.id, p)).all());
      const owners = new Map(byIds(rows.map((r) => r.followUpOwnerPersonId), (p) => d.select({ id: schema.people.id, name: schema.people.name }).from(schema.people).where(inArray(schema.people.id, p)).all()).map((r) => [r.id, r.name]));
      const today = todayIso();
      for (const r of rows) put(r.id, [...communicationNoteBits(r), followUpBit(r.followUpPromised, followUpState(r, today, r.followUpOwnerPersonId ? owners.get(r.followUpOwnerPersonId) : null))]);
      break;
    }
    case 'record':
      for (const r of byIds(ids, (p) => d.select({ id: schema.recordsInventory.id, notes: schema.recordsInventory.notes }).from(schema.recordsInventory).where(inArray(schema.recordsInventory.id, p)).all())) put(r.id, [userNote(r.notes)]);
      break;
    case 'task': {
      const rows = byIds(ids, (p) => d.select({ id: schema.tasks.id, detail: schema.tasks.detail, sourceType: schema.tasks.sourceType, sourceId: schema.tasks.sourceId }).from(schema.tasks).where(inArray(schema.tasks.id, p)).all());
      const findingTexts = findingTaskTexts(rows);
      for (const r of rows) put(r.id, [taskDetailBit(r, findingTexts)]);
      break;
    }
    case 'finding':
      for (const r of byIds(ids, (p) => d.select({ id: schema.findings.id, note: schema.findings.verdictNote }).from(schema.findings).where(inArray(schema.findings.id, p)).all())) put(r.id, [findingNoteBit(r.note)]);
      break;
    case 'encounter':
      for (const r of byIds(ids, (p) => d.select().from(schema.encounters).where(inArray(schema.encounters.id, p)).all())) put(r.id, encounterNoteBits(r));
      break;
    case 'medication': {
      const rows = byIds(ids, (p) => d.select().from(schema.medications).where(inArray(schema.medications.id, p)).all());
      const sources = loadFactTexts(rows.map((r) => r.sourceFactId));
      for (const r of rows) put(r.id, medicationNoteBits(r, sourceTexts(r.sourceFactId ? sources.get(r.sourceFactId) : null)));
      break;
    }
    case 'medication_event': {
      const rows = byIds(ids, (p) =>
        d
          .select({ id: schema.medicationEvents.id, detail: schema.medicationEvents.detail, dose: schema.medicationEvents.dose, sourceFactId: schema.medicationEvents.sourceFactId, medFactId: schema.medications.sourceFactId })
          .from(schema.medicationEvents)
          .leftJoin(schema.medications, eq(schema.medications.id, schema.medicationEvents.medicationId))
          .where(inArray(schema.medicationEvents.id, p))
          .all(),
      );
      const sources = loadFactTexts(rows.flatMap((r) => [r.sourceFactId, r.medFactId]));
      for (const r of rows) put(r.id, [r.dose ? `dose ${r.dose}` : null, medEventDetailBit(r.detail, sourceTexts(r.sourceFactId ? sources.get(r.sourceFactId) : null, r.medFactId ? sources.get(r.medFactId) : null))]);
      break;
    }
    case 'lab': {
      const rows = byIds(ids, (p) => d.select({ id: schema.labResults.id, notes: schema.labResults.notes, factId: schema.labResults.factId }).from(schema.labResults).where(inArray(schema.labResults.id, p)).all());
      const checks = liveCheckNotes(rows.map((r) => r.factId));
      for (const r of rows) put(r.id, labNoteBits(r.notes, r.factId ? checks.get(r.factId) : null));
      break;
    }
    case 'imaging': {
      const rows = byIds(ids, (p) => d.select({ id: schema.imagingStudies.id, notes: schema.imagingStudies.notes, factId: schema.imagingStudies.factId }).from(schema.imagingStudies).where(inArray(schema.imagingStudies.id, p)).all());
      const sources = loadFactTexts(rows.map((r) => r.factId));
      const checks = liveCheckNotes(rows.map((r) => r.factId));
      for (const r of rows) put(r.id, imagingNoteBits(r.notes, sourceTexts(r.factId ? sources.get(r.factId) : null), r.factId ? checks.get(r.factId) : null));
      break;
    }
    case 'intolerance': {
      const rows = byIds(ids, (p) => d.select({ id: schema.intolerances.id, notes: schema.intolerances.notes, sourceFactId: schema.intolerances.sourceFactId }).from(schema.intolerances).where(inArray(schema.intolerances.id, p)).all());
      const checks = liveCheckNotes(rows.map((r) => r.sourceFactId));
      for (const r of rows) put(r.id, [userNote(r.notes), checkNote(r.sourceFactId ? checks.get(r.sourceFactId) : null)]);
      break;
    }
    case 'document':
      for (const r of byIds(ids, (p) => d.select({ id: schema.documents.id, notes: schema.documents.notes, tagsJson: schema.documents.tagsJson }).from(schema.documents).where(inArray(schema.documents.id, p)).all())) put(r.id, documentNoteBits(r.notes, parseJson<unknown[]>(r.tagsJson, []).map(String)));
      break;
    case 'daily':
      for (const r of byIds(ids, (p) => d.select().from(schema.dailyLog).where(inArray(schema.dailyLog.id, p)).all())) put(r.id, dailyLogBits(r));
      break;
    case 'symptom': {
      const rows = byIds(ids, (p) =>
        d
          .select({ date: schema.symptomEntries.date, note: schema.symptomEntries.note, name: schema.symptomDefinitions.name })
          .from(schema.symptomEntries)
          .innerJoin(schema.symptomDefinitions, eq(schema.symptomDefinitions.id, schema.symptomEntries.symptomId))
          .where(and(inArray(schema.symptomEntries.date, p), sql`trim(coalesce(${schema.symptomEntries.note}, '')) != ''`))
          .orderBy(schema.symptomEntries.date, schema.symptomDefinitions.sortOrder)
          .all(),
      );
      const byDate = new Map<string, string[]>();
      for (const r of rows) {
        const bit = userNote(r.note, `${r.name} note`);
        if (!bit) continue;
        if (!byDate.has(r.date)) byDate.set(r.date, []);
        byDate.get(r.date)!.push(bit);
      }
      for (const [date, bits] of byDate) put(date, bits);
      break;
    }
  }
  return out;
}

/** Search hit types that are items with notes (a page is not). */
const HIT_NOTE_KINDS = new Set<string>(['fact', 'person', 'communication', 'record', 'task', 'finding', 'encounter', 'medication', 'lab', 'imaging', 'intolerance', 'document']);

function hitLine(h: SearchHit, markers: Map<string, string> = new Map(), notes: Map<string, string[]> = new Map(), rowMarkers: Map<string, string> = new Map()): string {
  const n = notes.get(`${h.type}:${h.id}`);
  const tail = n?.length ? ` · ${n.join(' · ')}` : '';
  // With the notes attached in full, the snippet (a few words, often of the same note) would repeat them.
  const snippet = h.snippet && !tail ? `: ${h.snippet.replace(/\s+/g, ' ').trim()}` : '';
  // A lab row or imaging study carries the trust of the detail it was made from, as in the ledger.
  const rowMarker = rowMarkers.get(`${h.type}:${h.id}`);
  switch (h.type) {
    case 'fact':
      return `fact ${tokF(h.id)} ${h.date ?? 'undated'} ${markers.get(h.id) ?? `[${h.snippet ?? ''}]`} ${h.title}${tail}`;
    case 'page':
      return `page ${tokD(h.documentId ?? h.id, h.pageNumber ?? 1)} ${h.title}${snippet}`;
    case 'communication':
      return `communication ${tokC(h.id)} ${h.title}${snippet}${tail}`;
    case 'document':
      return `document ${tokD(h.id)} ${h.title}${snippet}${tail}`;
    default:
      return `${h.type} (id ${h.id}) ${h.title}${rowMarker ? ` ${rowMarker}` : ''}${snippet}${tail}`;
  }
}

function runSearch(input: z.infer<typeof toolInputSchemas.search_case>): string {
  const hits = searchAll(input.query, { limit: input.limit ?? 40, types: input.types ?? undefined, allPages: true });
  if (!hits.length) return `No matches for "${input.query}". Try fewer or different words; every word must appear.`;
  // A search hit names no document: [verified] names its record here.
  const checks = factChecks(hits.filter((h) => h.type === 'fact').map((h) => h.id), false);
  const markers = new Map([...checks].map(([id, c]) => [id, c.marker]));
  const rowMarkers = new Map<string, string>();
  for (const kind of ['lab', 'imaging'] as const) {
    for (const [id, m] of rowTrust(kind, hits.filter((h) => h.type === kind).map((h) => h.id))) rowMarkers.set(`${kind}:${id}`, m);
  }
  // The notes the patient or his team wrote on each hit, in full: a snippet shows only a few words.
  const notes = new Map<string, string[]>();
  for (const kind of new Set(hits.map((h) => h.type).filter((t) => HIT_NOTE_KINDS.has(t)))) {
    for (const [id, bits] of itemNotes(kind as NoteKind, hits.filter((h) => h.type === kind).map((h) => h.id))) notes.set(`${kind}:${id}`, bits);
  }
  return [`${hits.length} matches for "${input.query}" (best first). Text marked (patient or team) was written by the patient or his team:`, ...hits.map((h) => hitLine(h, markers, notes, rowMarkers))].join('\n');
}

function runFacts(input: z.infer<typeof toolInputSchemas.get_facts>): string {
  const d = db();
  const f = schema.facts;
  const conds: SQL[] = [isNull(f.deletedAt), sql`${f.status} != 'superseded'`, sql`(${f.sourceDocumentId} is null or exists (select 1 from documents dd where dd.id = ${f.sourceDocumentId} and dd.deleted_at is null))`];
  if (input.type) conds.push(eq(f.type, input.type));
  if (input.status) conds.push(eq(f.status, input.status));
  if (input.documentId) conds.push(eq(f.sourceDocumentId, input.documentId));
  if (input.subject?.trim()) {
    const key = normalizeKey(input.subject);
    const pat = `%${key.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const match = ftsQuery(input.subject);
    const likeSubject = sql`${f.subjectKey} like ${pat} escape '\\'`;
    const likeStatement = sql`lower(${f.statement}) like ${pat} escape '\\'`;
    conds.push(match ? sql`(${likeSubject} or ${likeStatement} or ${f.id} in (select fact_id from facts_fts where facts_fts match ${match}))` : sql`(${likeSubject} or ${likeStatement})`);
  }
  const ids = new Set(
    d
      .select({ id: f.id })
      .from(f)
      .where(and(...conds))
      .all()
      .map((r) => r.id),
  );
  const people = loadPeople();
  const all = loadLedgerFacts().filter((x) => ids.has(x.id) && within(x.date, input.from, input.to));
  const limit = input.limit ?? 100;
  const shown = all.slice(0, limit);
  if (!shown.length) return 'No facts match these filters.';
  return [`${all.length} fact${all.length === 1 ? '' : 's'}${all.length > shown.length ? ` (showing the first ${shown.length}; narrow the filters)` : ''}, oldest first. Format: date [trust] [the patient's answer]? statement {attributes} (source ⟦D:id p.N⟧) note (patient or team): "the note written when checking it"? ⟦F:factId⟧`, ...shown.map((x) => `${x.type}: ${factLine(x, people)}`)].join('\n');
}

type LabsRow = ReturnType<typeof labsFindLabSeries>[number];

function fromLabsRow(r: LabsRow): LabRow {
  return {
    labResultId: r.labResultId,
    factId: r.factId,
    factStatus: r.factStatus,
    factBasis: r.factBasis,
    analyte: r.analyte,
    analyteKey: r.analyteKey,
    date: r.date,
    datePrecision: r.datePrecision,
    dateText: r.dateText,
    value: r.valueNum,
    valueText: r.valueText,
    unit: r.unit,
    refLow: r.refLow,
    refHigh: r.refHigh,
    refText: r.refText,
    flag: r.flag,
    specimen: r.specimen,
    labName: r.labName,
    documentId: r.documentId,
    documentTitle: r.documentTitle,
    pageNumber: r.pageNumber,
    notes: r.notes,
    factNote: null,
    trust: r.trust ?? null,
    editedFrom: r.editedFrom ?? null,
    editedFromRecord: r.editedFromRecord ?? null,
    // A test read out of a line of several (labs.ts readLabLine): the line as written, said beside the value.
    splitFrom: r.splitFrom?.text ?? null,
    combined: r.combined,
    // The Labs page's reading (labs.ts LabEntry.reading): what labRowLine prints.
    reading: r.reading,
    // A value the patient computed (2026-10-09): labRowLine says "computed by the patient" and cites its inputs' pages.
    computed: askComputedOf(r.computed),
  };
}

type SeriesArgs = { analyte: string; specimen: string | null; from: string | null; to: string | null };

/** The name most often written among these rows. */
function mostCommonText(values: Array<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  for (const [v, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = v;
  return best;
}

/** The tool's specimen 'any' means no specimen filter in the labs service. */
function seriesQuery(q: SeriesArgs): SeriesArgs {
  return { ...q, specimen: q.specimen && q.specimen !== 'any' ? q.specimen : null };
}

/**
 * Rows for one analyte from the labs service (lab_results rows merged with unimported lab_result facts), chronological,
 * with the notes on them: a note on a copy of a record's value set aside by the check goes on the record's row, and a
 * row standing for a record's value from another document cites the record's page too (as in the ledger).
 */
function labSeries(q: SeriesArgs, entries: LabEntry[] = loadLabEntries()): LabRow[] {
  // One read of the Labs page's entries, for the series and for the notes on copies (the same rows either way).
  const rows = labsFindLabSeries(seriesQuery(q), entries).map(fromLabsRow);
  const checks = factChecks(rows.map((r) => r.factId));
  for (const r of rows) {
    const c = r.factId ? checks.get(r.factId) : undefined;
    r.factNote = c?.note ?? null;
    r.factTier = c ? c.tier : undefined;
  }
  attachCopyNotes(rows, setAsideLabNotes(entries));
  attachRecordCites(rows);
  return rows;
}

/**
 * The tool's answer when the name does not exactly name a test on file (rule 9): never rows of a similar test, the
 * reason and the similar tests on file instead; null when the name is exact or nothing similar is on file.
 */
function unmatchedAnswer(input: { analyte: string; specimen?: string | null }, entries?: LabEntry[]): string | null {
  const match = matchLabAnalyte(seriesQuery({ analyte: input.analyte, specimen: input.specimen ?? null, from: null, to: null }), entries);
  // Nothing similar on file either: the plain answer (no stored results, the analytes on file) says it.
  if (match.status === 'exact' || (match.status === 'none' && !match.candidates.length)) return null;
  const similar = match.candidates.map((k) => analyteLabel(k));
  return `${match.reason}${similar.length ? ` Similar tests on file (different tests, never merged): ${similar.join('; ')}.` : ''} No rows were given for "${input.analyte}": ask again by the exact name of one test.`;
}

function runLabSeries(input: z.infer<typeof toolInputSchemas.get_lab_series>): string {
  const entries = loadLabEntries();
  const rows = labSeries({ analyte: input.analyte, specimen: input.specimen ?? null, from: input.from ?? null, to: input.to ?? null }, entries);
  if (!rows.length) {
    const unmatched = unmatchedAnswer(input, entries);
    if (unmatched) return unmatched;
    const known = listAnalytes().items.map((a) => `${a.analyte} (${a.specimen})`);
    return `No stored results for "${input.analyte}"${input.specimen && input.specimen !== 'any' ? ` in ${input.specimen}` : ''}. Analytes on file: ${known.length ? known.join('; ') : 'none'}. Values that were never extracted as lab facts may still appear in page text: try search_case.`;
  }
  const specimens = [...new Set(rows.map((r) => r.specimen).filter(Boolean))];
  return [`${rows.length} result${rows.length === 1 ? '' : 's'} for ${input.analyte}${specimens.length ? ` (${specimens.join(', ')})` : ''}, chronological. Format: ${LAB_ROW_FORMAT}`, ...rows.map(labRowLine)].join('\n');
}

function runDocumentPages(input: z.infer<typeof toolInputSchemas.get_document_pages>): string {
  const from = input.from ?? 1;
  const to = Math.min(input.to ?? from + 19, from + 19);
  const doc = db().select({ id: schema.documents.id, title: schema.documents.title, pageCount: schema.documents.pageCount, notes: schema.documents.notes, tagsJson: schema.documents.tagsJson, metadataJson: schema.documents.metadataJson }).from(schema.documents).where(and(eq(schema.documents.id, input.documentId), isNull(schema.documents.deletedAt))).get();
  if (!doc) return `No document with id ${input.documentId}. Use list_documents to find ids.`;
  // A hospital chart print stores its pages in the PDF's drawing order, where a note's heading (author, time) can come
  // after its body; the clinician reads such pages in reading order, rebuilt from their line boxes (integration,
  // 2026-10-07). Quotes from either form verify (ask.ts mapAnswer).
  const readingOrder = parseExportInfo(parseJson<Record<string, unknown>>(doc.metadataJson, {})) != null;
  // What the patient or his team wrote on the document, ahead of its pages.
  const notes = documentNoteBits(doc.notes, parseJson<unknown[]>(doc.tagsJson, []).map(String));
  const notesLine = notes.length ? `\n${notes.join(' · ')}` : '';
  const pages = getPages(doc.id, from, to);
  if (!pages.length) return `${doc.title} ${tokD(doc.id)} has no text for pages ${from}-${to} (${doc.pageCount} pages on file).${notesLine}`;
  const body = pages.map((p) => `=== PAGE ${p.pageNumber} === ${tokD(doc.id, p.pageNumber)}\n${((readingOrder ? visualPageText(p) : null) ?? p.text).trimEnd()}`).join('\n\n');
  return cap(`Document: ${doc.title} ${tokD(doc.id)} (${doc.pageCount} pages; showing ${pages[0].pageNumber}-${pages[pages.length - 1].pageNumber}${readingOrder ? '; in reading order, cells of a row separated by " | "' : ''})${notesLine}\n\n${body}`);
}

function timelineToken(kind: TimelineKind, id: string, documentId: string | null | undefined): string {
  switch (kind) {
    case 'fact':
      return tokF(id);
    case 'communication':
      return tokC(id);
    case 'document':
      return tokD(id);
    default:
      return documentId ? tokD(documentId) : `(${kind} ${id})`;
  }
}

function runTimeline(input: z.infer<typeof toolInputSchemas.get_timeline>): string {
  const kinds = input.kinds?.filter(isTimelineKind) ?? null;
  // The words may name a note this tool prints (qNotes); the Timeline page searches its own columns only.
  const res = listTimeline({ from: input.from || null, to: input.to || null, kinds: kinds?.length ? kinds : null, q: input.q ?? null, qNotes: true, limit: 600 });
  if (!res.items.length) return `Nothing dated between ${input.from || 'the start'} and ${input.to || 'now'}${input.q ? ` matching "${input.q}"` : ''}.`;
  // A fact a patient statement takes precedence over is marked, as in the ledger, while that statement is live.
  const live = liveFactIds(res.items.map((it) => (it.kind === 'fact' ? it.overriddenBy : null)));
  const checks = factChecks(res.items.filter((it) => it.kind === 'fact').map((it) => it.id));
  // Lab rows and imaging studies carry the trust of the detail they were made from, as in the ledger.
  const rowMarkers = new Map<string, string>();
  for (const kind of ['lab', 'imaging'] as const) {
    for (const [id, m] of rowTrust(kind, res.items.filter((it) => it.kind === kind).map((it) => it.id))) rowMarkers.set(`${kind}:${id}`, m);
  }
  // The notes the patient or his team wrote on each item, in full (the timeline's own detail is one clipped field).
  const notes = new Map<string, string[]>();
  for (const kind of new Set(res.items.map((it) => it.kind))) {
    if (!TIMELINE_NOTE_KINDS.has(kind)) continue;
    for (const [id, bits] of itemNotes(kind as NoteKind, res.items.filter((it) => it.kind === kind).map((it) => it.id))) notes.set(`${kind}:${id}`, bits);
  }
  const lines = res.items.map((it) => {
    const bits = notes.get(`${it.kind}:${it.id}`) ?? [];
    const clipped = it.detail ? it.detail.replace(/\s+/g, ' ').trim().slice(0, 240) : null;
    // These kinds' bits carry the whole detail (the timeline shows only one of their fields); a document's note replaces the note it shows.
    const replaces = bits.length > 0 && (REPLACING_KINDS.has(it.kind) || (it.kind === 'document' && bits.some((b) => b.startsWith('note '))));
    return [
      it.date,
      it.kind.replace(/_/g, ' '),
      it.subKind ? `(${it.subKind})` : null,
      it.title,
      !replaces && clipped ? `— ${clipped}` : null,
      it.kind === 'fact' && checks.has(it.id) ? checks.get(it.id)!.marker : it.status ? `[${it.status}]` : null,
      it.kind === 'lab' || it.kind === 'imaging' ? (rowMarkers.get(`${it.kind}:${it.id}`) ?? null) : null,
      it.personName ? `· ${it.personName}` : null,
      it.kind === 'fact' && it.overriddenBy && live.has(it.overriddenBy) ? '[patient view differs]' : null,
      bits.length ? `· ${bits.join(' · ')}` : null,
      timelineToken(it.kind, it.id, it.documentId),
    ]
      .filter(Boolean)
      .join(' ');
  });
  return cap([`${res.items.length} dated items (${Object.entries(res.counts).filter(([k, v]) => k !== 'undated' && v).map(([k, v]) => `${v} ${k}`).join(', ')}), oldest first. Text marked (patient or team) was written by the patient or his team:`, ...lines].join('\n'));
}

/** Timeline kinds whose items carry notes, and those whose note bits stand in for the timeline's clipped detail. */
const TIMELINE_NOTE_KINDS = new Set<string>(['document', 'fact', 'communication', 'encounter', 'medication_event', 'lab', 'imaging', 'symptom', 'daily', 'task', 'finding']);
const REPLACING_KINDS = new Set<string>(['communication', 'encounter', 'medication_event', 'daily', 'task']);

function runCommunications(input: z.infer<typeof toolInputSchemas.get_communications>): string {
  const items = listCommunications({ personId: input.personId ?? null, topic: input.topic ?? null, from: input.from ?? null, to: input.to ?? null, q: input.q ?? null, limit: 500 });
  if (!items.length) return 'No communications match these filters.';
  const today = todayIso();
  const titles = new Map<string, string>();
  for (const c of items) if (c.documentId && c.documentTitle) titles.set(c.documentId, c.documentTitle);
  const lines = sortCommunications(items.slice()).map((c) => {
    const d = parseCommunicationDetails(c.detailsJson);
    return [
      `${fmtDate(c.occurredAt, c.occurredAtPrecision)}${c.occurredTime ? ` ${c.occurredTime}` : ''}`,
      `${c.direction} ${c.channel}`,
      messageAuthorBit(d) ?? (c.participants.length ? `with ${c.participants.map((p) => `${p.name}${p.role !== 'to' ? ` (${p.role})` : ''}`).join(', ')}` : null),
      c.subject,
      ...communicationBits(c, d, MESSAGE_LEDGER_CHARS * 2, followUpState(c, today, c.followUpOwnerName)),
      c.topics.length ? `topics: ${c.topics.join(', ')}` : null,
      c.threadKey ? `thread ${c.threadKey}` : null,
      c.documentId ? communicationSourceBit(c.documentId, d, titles.get(c.documentId) ?? 'document', isFromRecord(d, c.body)) : null,
      tokC(c.id),
    ]
      .filter(Boolean)
      .join(' · ');
  });
  return cap([`${items.length} communication${items.length === 1 ? '' : 's'}, oldest first. ${COMMUNICATIONS_LEGEND}`, ...lines].join('\n'));
}

function runListDocuments(input: z.infer<typeof toolInputSchemas.list_documents>): string {
  const docs = listDocuments({ q: input.q ?? undefined, category: input.category ?? undefined, sort: 'date', limit: 500 }).filter((d) => within(d.documentDate, input.from, input.to));
  if (!docs.length) return 'No documents match these filters.';
  return [
    `${docs.length} document${docs.length === 1 ? '' : 's'}, oldest first. Format: ⟦D:id⟧ date · title · category · pages · institution · details · how much was read · tags (patient or team)? · note (patient or team): "…"? A document "partly read" holds details from only the pages named: say so when an answer leans on it, and get_document_coverage gives the rest.`,
    ...docs.map((d) =>
      [
        tokD(d.id),
        fmtDate(d.documentDate, d.documentDatePrecision),
        d.title,
        d.category.replace(/_/g, ' '),
        `${d.pageCount} p.`,
        d.institutionName ?? null,
        d.factsCount ? `${d.factsCount} facts` : null,
        `${extractionWords(d.extractionStatus)}: ${readingWords(d, coverageOfMetadata(d.metadataJson))}`,
        labCheckBit(storedLabCheck(d.metadataJson)),
        ...documentNoteBits(d.notes, parseJson<unknown[]>(d.tagsJson, []).map(String)),
      ]
        .filter(Boolean)
        .join(' · '),
    ),
  ].join('\n');
}

/** A document's lab check in a few words for list_documents, only when lab lines are still missing from the table. */
function labCheckBit(r: LabCheckReport | null): string | null {
  if (!r || !r.missed) return null;
  return `lab check: ${n0(r.missed)} lab line${r.missed === 1 ? '' : 's'} on read pages not in the lab table (get_document_coverage names them)`;
}

// ---------------------------------------------------------------------------
// Large exports (2026-10-07): coverage, outline, threads, and the bulk actions the patient can ask for
// ---------------------------------------------------------------------------

const n0 = (x: number): string => x.toLocaleString('en-US');

function liveDocument(id: string) {
  return db()
    .select({ id: schema.documents.id, title: schema.documents.title, pageCount: schema.documents.pageCount, extractionStatus: schema.documents.extractionStatus, textStatus: schema.documents.textStatus, category: schema.documents.category, sourceTier: schema.documents.sourceTier, metadataJson: schema.documents.metadataJson })
    .from(schema.documents)
    .where(and(eq(schema.documents.id, id), isNull(schema.documents.deletedAt)))
    .get();
}

/** At most `max` page ranges in words, with how many pages they hold. */
function rangeList(ranges: Array<[number, number]>, max = 40): string {
  const pages = ranges.reduce((n, [a, b]) => n + b - a + 1, 0);
  const shown = ranges.length > max ? `${formatPageRanges(ranges.slice(0, max))} and ${n0(ranges.length - max)} more ranges` : formatPageRanges(ranges);
  return `${shown} (${n0(pages)} page${pages === 1 ? '' : 's'})`;
}

/** What the last reading found, from the ingestion report (counts and plain words; no record text). */
function reportLines(r: IngestionReport): string[] {
  const out: string[] = [`What the reading of ${localStamp(r.at)} found:`];
  const kinds = Object.entries(r.communications.byKind).filter(([, v]) => v).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}${v === 1 ? '' : 's'}`);
  out.push(`- calls and messages read out of it: ${r.communications.created} new, ${r.communications.updated} updated, ${r.communications.unchanged} unchanged${kinds.length ? ` (${kinds.join(', ')})` : ''}`);
  out.push(`- threads: ${r.threads.total} (${r.threads.created} new)${r.threads.mergedWithFiled.length ? `; ${r.threads.mergedWithFiled.length} joined with a separately filed copy (${r.threads.mergedWithFiled.map((m) => `${tokC(m.communicationId)} filed as ${tokD(m.filedDocumentId)}`).join(', ')})` : ''}`);
  if (r.people.created.length || r.people.suggested.length)
    out.push(`- people: ${r.people.created.length} added (${r.people.created.map((p) => p.name).slice(0, 20).join(', ') || 'none'}); ${r.people.suggested.length} suggested, never merged without the patient (${r.people.suggested.slice(0, 20).map((p) => `${p.name}${p.matchName ? ` may be ${p.matchName}` : ''}`).join('; ') || 'none'})`);
  out.push(`- records checklist: ${r.gaps.closed.length} gap${r.gaps.closed.length === 1 ? '' : 's'} closed${r.gaps.closed.length ? ` (${r.gaps.closed.slice(0, 20).map((g) => `${g.title}${g.pages ? ` pp.${g.pages[0]}-${g.pages[1]}` : ''}`).join('; ')})` : ''}; ${r.gaps.heldRowsCreated} ${r.gaps.heldRowsCreated === 1 ? 'visit' : 'visits'} listed as held; ${r.gaps.open} still open across the case`);
  out.push(`- trust: ${r.trust.passagesBelowDocument} passages trusted below the document (the patient's own words inside it), ${r.trust.changed} changed in this reading`);
  out.push(`- medications: ${r.medications.filed} filed, ${r.medications.conflicts} conflicts${r.medications.reconciled ? ', reconciled' : ''}`);
  out.push(`- checks across the records: ${r.findings.new} new and ${r.findings.cleared} cleared involving this document${r.findings.caseNew != null ? ` (the whole case: ${r.findings.caseNew} new, ${r.findings.caseCleared ?? 0} cleared)` : ''}`);
  for (const n of r.notes.slice(0, 20)) out.push(`- ${n}`);
  return out;
}

function runDocumentCoverage(input: z.infer<typeof toolInputSchemas.get_document_coverage>): string {
  const doc = liveDocument(input.documentId);
  if (!doc) return `No document with id ${input.documentId}. Use list_documents to find ids.`;
  const cov: DocumentCoverage | null = currentCoverage(doc.id) ?? coverageOfMetadata(doc.metadataJson);
  const conf = uploadConfirmation(doc.id);
  const upload = readUploadRecord(doc.id);
  const lines: string[] = [`Document: ${doc.title} ${tokD(doc.id)} (${n0(doc.pageCount)} pages; ${extractionWords(doc.extractionStatus)})`];
  lines.push(`In one sentence: ${conf.sentence}`);
  if (upload) {
    lines.push(
      `Upload check: ${formatBytes(upload.bytesReceived)} arrived${upload.bytesStored != null ? `, ${formatBytes(upload.bytesStored)} stored` : ''}${upload.readBackOk == null ? '' : upload.readBackOk ? ', read back and matched' : ', the stored copy does NOT match what arrived'}; ${upload.pagesInFile != null ? `the file has ${n0(upload.pagesInFile)} pages, ${n0(upload.pagesStored)} stored` : `${n0(upload.pagesStored)} pages stored`}; ${n0(upload.pagesWithText)} with text${upload.pagesNoText.length ? `; no text on ${formatPageRanges(pagesFromList(upload.pagesNoText))}` : ''}.${upload.problems.length ? ` Problems: ${upload.problems.join(' ')}` : ''}`,
    );
  } else lines.push('Upload check: not recorded (added before the app checked uploads page by page).');
  lines.push(`Reading: ${readingWords(doc, cov)}`);
  if (cov && cov.pagesTotal) {
    lines.push(`Pages, ${cov.basis === 'legacy' ? 'worked out from an earlier reading (before documents were cut into parts)' : `from ${n0(cov.segments.total)} parts`}:`);
    const done = pagesInState(cov, ['done']);
    if (done.length) lines.push(`- details pulled out by Claude: ${rangeList(done)}`);
    const parsed = pagesInState(cov, ['parsed']);
    if (parsed.length) lines.push(`- messages, notes, letters or questionnaires read word for word without the model: ${rangeList(parsed)}`);
    const reasons: Record<string, string> = { duplicate: 'repeats of an earlier page', boilerplate: 'repeated cover sheets and insurance blocks', blank: 'blank', no_text: 'nothing readable (a scan OCR found no words on)' };
    for (const key of ['duplicate', 'boilerplate', 'blank', 'no_text'] as const) {
      const r = cov.skipRanges.filter((x) => x[2] === key).map(([a, b]) => [a, b] as [number, number]);
      if (r.length) lines.push(`- skipped, ${reasons[key]}: ${rangeList(r)}`);
    }
    for (const f of cov.failures.slice(0, 30)) lines.push(`- could not be read: ${formatPageRanges([f.pages])}: ${f.reason.replace(/^could not be read:\s*/i, '')}`);
    if (cov.pagesFailed && !cov.failures.length) lines.push(`- could not be read: ${rangeList(pagesInState(cov, ['failed']))}`);
    const running = pagesInState(cov, ['running']);
    if (running.length) lines.push(`- being read now: ${rangeList(running)}`);
    const pending = pagesInState(cov, ['pending']);
    if (pending.length) lines.push(`- not read yet: ${rangeList(pending)}`);
    if (cov.pagesImage || cov.pagesOcr) lines.push(`- scanned pages: ${n0(Math.max(cov.pagesImage, cov.pagesOcr))}; read by OCR: ${n0(cov.pagesOcr)}${cov.ocrRanges.length ? ` (${rangeList(cov.ocrRanges, 20)})` : ''}`);
  }
  if (cov?.resume?.kind === 'labcheck') {
    // The lab check's question (2026-10-09): read again the pages with lab lines no value holds, above his limit.
    const r = cov.resume;
    const pages = r.pages?.length ? formatPageRanges(r.pages) : `${n0(r.pagesLeft)} pages`;
    const words = r.decision === 'ask' ? `waiting for the patient's go-ahead (about $${r.estimateUsd.toFixed(2)} for ${n0(r.rows ?? 0)} lab lines on ${pages}${r.calls ? ` in ${n0(r.calls)} small calls` : ''}, above his limit of $${r.ceilingUsd.toFixed(2)}); he answers on the document's page, or propose_reprocess_many with scope missing asks him` : r.decision === 'declined' ? 'the patient said not now (the lines were added from the page as printed instead)' : 'the patient said yes';
    lines.push(`Reading again the pages where the lab check found lab lines no value holds: ${words}.`);
  } else if (cov?.resume) {
    const r = cov.resume;
    const words = r.decision === 'ask' ? `waiting for the patient's go-ahead (about $${r.estimateUsd.toFixed(2)}, above his limit of $${r.ceilingUsd.toFixed(2)})` : r.decision === 'declined' ? 'the patient said not now' : r.decision === 'approved' ? 'the patient said yes' : `started on its own (about $${r.estimateUsd.toFixed(2)}, within his limit of $${r.ceilingUsd.toFixed(2)})`;
    lines.push(`Reading the rest: ${words}; ${n0(r.pagesLeft)} pages left in ${n0(r.segmentsLeft)} parts.`);
  }
  try {
    const est = estimateRemaining(doc.id, 'missing');
    if (est.calls) lines.push(`To read what is left: about $${est.approxUsd.toFixed(2)} (${n0(est.pages)} page${est.pages === 1 ? '' : 's'} in ${n0(est.calls)} model call${est.calls === 1 ? '' : 's'}). propose_reprocess_many with scope missing does it.`);
    else if (cov?.state === 'complete') lines.push('Nothing is left to read: every page was read once. Pages can still be read again (propose_reprocess_many with scope pages reads them even when they were read before), and a lab line no stored value holds can be added with add_lab_value_from_page.');
  } catch {
    // No estimate (no pages yet).
  }
  const comms = db()
    .select({ n: sql<number>`count(*)` })
    .from(schema.communications)
    .where(and(eq(schema.communications.documentId, doc.id), isNull(schema.communications.deletedAt)))
    .get();
  if (comms?.n) lines.push(`Calls and messages from it: ${n0(comms.n)} (get_communications lists them; get_thread reads a thread).`);
  const labCheck = cov?.labCheck ?? storedLabCheck(doc.metadataJson);
  if (labCheck) lines.push(...labCheckLines(labCheck, doc.id));
  const report = cov?.report ?? storedReport(doc.metadataJson);
  if (report) lines.push(...reportLines(report));
  return cap(lines.join('\n'));
}

/** The ingestion report as stored, read on its own (the coverage around it may not be written yet). */
function storedReport(metadataJson: string | null | undefined): IngestionReport | null {
  const meta = parseJson<Record<string, unknown>>(metadataJson ?? '{}', {});
  const raw = meta.coverage && typeof meta.coverage === 'object' ? (meta.coverage as Record<string, unknown>).report : undefined;
  const r = raw ? ingestionReport.safeParse(raw) : null;
  return r?.success ? r.data : null;
}

/** The lab check as stored, read on its own (the coverage around it may not be written or may not read). */
function storedLabCheck(metadataJson: string | null | undefined): LabCheckReport | null {
  const meta = parseJson<Record<string, unknown>>(metadataJson ?? '{}', {});
  return meta.coverage && typeof meta.coverage === 'object' ? parseLabCheckReport((meta.coverage as Record<string, unknown>).labCheck) : null;
}

/** Sorted page numbers to ranges (a short list). */
function pagesFromList(pages: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const p of [...new Set(pages)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else out.push([p, p]);
  }
  return out;
}

/** A part's state in words. */
const PART_STATE_WORDS: Record<string, string> = {
  done: 'read',
  parsed: 'read word for word',
  skipped: 'skipped',
  no_text: 'nothing readable',
  failed: 'could not be read',
  running: 'being read',
  pending: 'not read yet',
};

function runDocumentOutline(input: z.infer<typeof toolInputSchemas.get_document_outline>): string {
  const doc = liveDocument(input.documentId);
  if (!doc) return `No document with id ${input.documentId}. Use list_documents to find ids.`;
  const all = documentOutline(doc.id);
  if (!all.length) return `${doc.title} ${tokD(doc.id)} has not been cut into parts yet (${n0(doc.pageCount)} pages); read it with get_document_pages.`;
  const from = input.fromPage ?? 1;
  const to = input.toPage ?? Number.MAX_SAFE_INTEGER;
  const entries = all.filter((e) => e.pageEnd >= from && e.pageStart <= to);
  const lines = [
    `Outline of ${doc.title} ${tokD(doc.id)}: ${all.length} entr${all.length === 1 ? 'y' : 'ies'} over ${n0(doc.pageCount)} pages${entries.length < all.length ? `; ${entries.length} between pages ${from} and ${input.toPage ?? doc.pageCount}` : ''}. Format: pages · date as printed · type in department · encounter # (only when printed) · read or not · details · messages ⟦D:id p.first⟧. The dates are the visits' own, never the print date.`,
  ];
  for (const e of entries) {
    lines.push(
      [
        `pp.${e.pageStart}-${e.pageEnd}`,
        e.dateText ?? (e.date ? fmtDate(e.date, e.datePrecision) : null),
        e.type ? `${e.type}${e.department ? ` in ${e.department}` : ''}` : (e.headerText ?? null),
        e.number ? `encounter #${e.number}` : null,
        PART_STATE_WORDS[e.state] ?? e.state,
        e.factsCount ? `${n0(e.factsCount)} ${e.factsCount === 1 ? 'detail' : 'details'}` : null,
        e.messagesCount ? `${n0(e.messagesCount)} ${e.messagesCount === 1 ? 'message' : 'messages'}` : null,
        tokD(doc.id, e.pageStart),
      ]
        .filter(Boolean)
        .join(' · '),
    );
    if (input.parts) {
      for (const s of e.segments) {
        const what = [s.kind.replace(/_/g, ' '), s.headerText && s.headerText !== e.headerText ? `"${s.headerText.slice(0, 80)}"` : null].filter(Boolean).join(' ');
        lines.push(`   ${s.pageStart === s.pageEnd ? `p.${s.pageStart}` : `pp.${s.pageStart}-${s.pageEnd}`} ${what} · ${PART_STATE_WORDS[s.status] ?? s.status}${s.skipReason ? ` (${s.skipReason.replace(/_/g, ' ')})` : ''}${s.error ? `: ${s.error}` : ''}`);
      }
    }
  }
  return cap(lines.join('\n'));
}

/** The longest message body get_thread prints (bodies are rarely this long). */
const THREAD_BODY_MAX = 12_000;

function runThread(input: z.infer<typeof toolInputSchemas.get_thread>): string {
  const c = schema.communications;
  let key = input.threadKey?.trim() || null;
  if (!key && input.communicationId) {
    const row = db().select({ threadKey: c.threadKey, id: c.id }).from(c).where(and(eq(c.id, input.communicationId.trim()), isNull(c.deletedAt))).get();
    if (!row) return `No communication with id ${input.communicationId}.`;
    if (!row.threadKey) return `${tokC(row.id)} is not part of a thread read out of a record; get_communications shows it.`;
    key = row.threadKey;
  }
  const rows = sortCommunications(db().select().from(c).where(and(eq(c.threadKey, key!), isNull(c.deletedAt))).all());
  if (!rows.length) return `No thread with key ${key}. Thread keys appear as "thread <key>" on get_communications lines.`;
  const docs = new Map(
    byIds(rows.map((r) => r.documentId), (part) => db().select({ id: schema.documents.id, title: schema.documents.title }).from(schema.documents).where(inArray(schema.documents.id, part)).all()).map((d) => [d.id, d.title]),
  );
  let outcome: string | null = null;
  let modelSummary: string | null = null;
  try {
    const t = getThread(key!);
    if (t.outcome?.trim()) outcome = `${t.outcomeSource === 'user' ? `outcome (patient or team)` : 'outcome (worked out from the replies)'}: "${t.outcome.trim()}"`;
    if (t.modelSummary?.text?.trim()) modelSummary = `Model summary (written by the model, not the record): "${t.modelSummary.text.trim()}"`;
  } catch {
    // The thread view is not available; the messages below are read directly.
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  const when = (r: (typeof rows)[number]) => `${fmtDate(r.occurredAt, r.occurredAtPrecision)}${r.occurredTime ? ` ${r.occurredTime}` : ''}`;
  const lines = [
    `Thread "${first.subject}" (${rows.length} message${rows.length === 1 ? '' : 's'}, ${when(first)} to ${when(last)}), oldest first. Every body is word for word as printed in the record; "the patient's own words" are his claims even inside a clinical record, never the record's own.`,
  ];
  if (outcome) lines.push(outcome);
  if (modelSummary) lines.push(modelSummary);
  rows.forEach((r, i) => {
    const d = parseCommunicationDetails(r.detailsJson);
    const page = messagePage(d);
    const pages = d.pages ? (d.pages[0] === d.pages[1] ? tokD(r.documentId ?? '', d.pages[0]) : `${tokD(r.documentId ?? '', d.pages[0])} to ${tokD(r.documentId ?? '', d.pages[1])}`) : r.documentId ? tokD(r.documentId, page ?? 1) : null;
    const head = [
      `${i + 1}. ${when(r)}`,
      d.sentLabel ? `"${d.sentLabel}"` : `${r.direction} ${r.channel}`,
      d.kind && d.kind !== 'portal_message' ? d.kind.replace(/_/g, ' ') : null,
      messageAuthorBit(d),
      ...(d.readReceipts ?? []).map((x) => `read ${x.atText} by ${x.byText}`),
      r.documentId ? `in ${docs.get(r.documentId) ?? 'document'}` : null,
      pages && r.documentId ? pages : null,
      tokC(r.id),
    ]
      .filter(Boolean)
      .join(' · ');
    lines.push(head);
    const body = r.body?.trim();
    if (body) lines.push(`   message (${d.voice ? VOICE_WORDS[d.voice] ?? d.voice : 'from the record'}): "${body.length > THREAD_BODY_MAX ? `${body.slice(0, THREAD_BODY_MAX)}…` : body}"`);
    else lines.push(`   ${communicationBits(r, d, 600).join(' · ') || '(no words recorded)'}`);
    for (const cp of d.copies ?? []) lines.push(`   also ${cp.kind === 'filed_copy' ? 'filed separately as' : 'printed in'} ${docs.get(cp.documentId) ?? 'another document'} ${tokD(cp.documentId, cp.pages?.[0] ?? null)}${cp.minutesApart != null ? ` (${cp.minutesApart} minute${cp.minutesApart === 1 ? '' : 's'} apart)` : ''}`);
    for (const m of (d.mentions ?? []).filter((x) => x.status !== 'declined')) lines.push(`   ${m.kind === 'mentioned_by' ? 'named by' : 'names'} ${m.communicationId ? tokC(m.communicationId) : m.documentId ? tokD(m.documentId, m.page) : 'another record'}${m.text ? ` ("${m.text}")` : ''}${m.status === 'suggested' ? ' (a suggested link, not confirmed)' : ''}`);
  });
  return cap(lines.join('\n'));
}

// --- Bulk actions ----------------------------------------------------------------

/** Words a request must use to be a request for that action ("read the rest", "move them to lab reports"). */
/** The verbs of a request to read or to move documents, whole words only (never "ready", "files", "type", "sort of"). */
type RequestAction = 'read' | 'move' | 'add';

const ACTION_VERBS: Record<RequestAction, string> = {
  read: String.raw`(?:re-?read|read|re-?process|reprocess|re-?run|redo|extract|ocr|go through|look through|continue reading|keep reading|finish reading|resume(?: reading)?)`,
  move: String.raw`(?:move|re-?file|refile|file|re-?classify|reclassify|re-?categori[sz]e|recategori[sz]e|categori[sz]e|put)`,
  // Putting a lab value into the table (2026-10-08, lab check): "Can you add it to the table?", "please put the 7.6 in".
  // Not "record", "log", "include" or a bare "pull" ("can you pull up my labs" asks for nothing to be added; 2026-10-09).
  add: String.raw`(?:add|re-?add|put|enter|insert|fill in|pull (?:it |that |this |them |the [a-z0-9.]+ )?(?:out|in|into))`,
};
/** Words that may open a request ("Yes, please read ...", "OK now move ..."). */
const OPENERS = String.raw`(?:(?:please|also|just|now|then|kindly|ok|okay|yes|and|so)[,\s]+)*`;
/** Phrases that make what follows a request ("can you", "I'd like you to"). */
const REQUEST = String.raw`\b(?:please|can you|could you|would you|will you|go ahead and|i want you to|i'd like you to|i would like you to)\s+`;

const actionWords = (verbs: string): RegExp => new RegExp(String.raw`^${OPENERS}${verbs}\b|${REQUEST}${OPENERS}${verbs}\b`);
const ACTION_WORDS: Record<RequestAction, RegExp> = {
  read: actionWords(ACTION_VERBS.read),
  move: actionWords(ACTION_VERBS.move),
  add: actionWords(ACTION_VERBS.add),
};

/**
 * True when the quoted words are in the patient's message (spacing, quotes and case aside), at least 6 characters,
 * and (with `action`) they ask for that action in the form of a request: the quote starts with the verb ("read the
 * rest", "Yes, please move them") or a request phrase comes right before it ("can you re-read ...", "I'd like you to
 * move ..."). A verb anywhere else (2026-10-07 review, rev-comms #6: "I read his message", "are you ready", "my files",
 * "what type of doctor") never stands for a request to read or move documents.
 */
export function askedInQuestion(quote: string | null | undefined, question: string | null | undefined, action?: RequestAction): boolean {
  const q = normalizeForHash(quote ?? '').replace(/^["'“”‘’]+|["'“”‘’.,;:!?]+$/g, '').trim();
  if (q.length < 6) return false;
  if (action && !ACTION_WORDS[action].test(q)) return false;
  return normalizeForHash(question ?? '').includes(q);
}

/** Counts unasked proposals against the per-answer cap; throws the refusal the model reads. */
function takeUnsolicited(ctx: ToolContext, n: number): void {
  const used = ctx.unsolicited ?? 0;
  if (used + n > MAX_PROPOSALS_PER_ANSWER) {
    throw new Error(
      `at most ${MAX_PROPOSALS_PER_ANSWER} documents can be proposed unasked in one answer (${used} already); propose the most important ones, and ask the patient whether he wants the rest done too (if he says so in his next message, quote his words in askedInMessage and they run in one go)`,
    );
  }
  ctx.unsolicited = used + n;
}

const SCOPE_WORDS: Record<string, string> = { missing: 'the pages not read yet', failed: 'the parts that could not be read', whole: 'every page again', pages: 'the given pages again' };

function reprocessLines(r: ReprocessResult, titleOf: (id: string) => string, asked: boolean): string[] {
  const out: string[] = [];
  if (r.queued.length) out.push(`Started (${r.queued.length}): ${r.queued.map((q) => `${titleOf(q.documentId)} ${tokD(q.documentId)} (${SCOPE_WORDS[q.scope] ?? q.scope}${q.estimateUsd != null ? `, about $${q.estimateUsd.toFixed(2)}` : ''})`).join('; ')}.`);
  if (r.askFirst.length)
    out.push(
      `${asked ? 'Waiting for one yes from the patient, because each costs more than his limit' : 'Waiting for the patient to approve it in the thread'} (${r.askFirst.length}): ${r.askFirst.map((a) => `${titleOf(a.documentId)} ${tokD(a.documentId)} (about $${a.estimateUsd.toFixed(2)})`).join('; ')}.`,
    );
  if (r.skipped.length) out.push(`Not started (${r.skipped.length}): ${r.skipped.map((s) => `${titleOf(s.documentId)} ${tokD(s.documentId)}: ${s.reason}`).join('; ')}.`);
  return out;
}

function runProposeReprocessMany(i: z.infer<typeof toolInputSchemas.propose_reprocess_many>, ctx: ToolContext): string {
  const ids = [...new Set(i.documentIds)];
  const asked = askedInQuestion(i.askedInMessage, ctx.question, 'read');
  if (!asked) takeUnsolicited(ctx, ids.length);
  const scope = i.scope ?? 'missing';
  if (scope === 'pages' && !i.pages?.length) throw new Error('with scope pages, say which pages (pages: [[first, last], ...])');
  const r = requestReprocess(
    { documentIds: ids, scope, pages: scope === 'pages' ? (i.pages as Array<[number, number]>) : undefined, deep: Boolean(i.deep), reason: i.reason, requestedBy: asked ? 'user' : 'consult', askMessageId: ctx.askMessageId ?? undefined, confirmAboveCeiling: false },
    { by: asked ? 'the patient, asking the clinician' : 'clinician' },
  );
  const proposals = (ctx.proposals ??= []);
  for (const id of r.filingIds) if (!proposals.includes(id)) proposals.push(id);
  const titles = new Map(byIds(ids, (part) => db().select({ id: schema.documents.id, title: schema.documents.title }).from(schema.documents).where(inArray(schema.documents.id, part)).all()).map((d) => [d.id, d.title]));
  const lines = reprocessLines(r, (id) => titles.get(id) ?? 'document', asked);
  const head = asked
    ? `As the patient asked ("${(i.askedInMessage ?? '').trim().slice(0, 200)}"), reading ${SCOPE_WORDS[scope]} of ${ids.length} document${ids.length === 1 ? '' : 's'}. Details he checked or edited are kept; nothing in the documents changes.`
    : `Proposed to the patient: reading ${SCOPE_WORDS[scope]} of ${ids.length} document${ids.length === 1 ? '' : 's'}. Nothing starts until he approves it in the thread.`;
  return [head, ...lines, 'Say in one line at the end of the answer what was started and what waits.'].join('\n');
}

function runProposeRefileMany(i: z.infer<typeof toolInputSchemas.propose_refile_many>, ctx: ToolContext): string {
  const asked = askedInQuestion(i.askedInMessage, ctx.question, 'move');
  const docIds = [...new Set(i.items.map((x) => x.documentId))];
  if (!asked) takeUnsolicited(ctx, docIds.length);
  const r = proposeMoves({ items: i.items, source: asked ? 'user' : 'consult', askMessageId: ctx.askMessageId ?? undefined, approve: asked }, { by: asked ? 'the patient, asking the clinician' : 'clinician' });
  const proposals = (ctx.proposals ??= []);
  for (const id of r.filingIds) if (!proposals.includes(id)) proposals.push(id);
  const parts = [
    asked
      ? `As the patient asked ("${(i.askedInMessage ?? '').trim().slice(0, 200)}"): ${r.applied} document${r.applied === 1 ? '' : 's'} moved, each with Undo under the answer.`
      : `Proposed to the patient: ${r.proposed} move${r.proposed === 1 ? '' : 's'}, waiting for his one "Approve all" in the thread; nothing has changed yet.`,
  ];
  if (asked && r.proposed) parts.push(`${r.proposed} wait for his approval in the thread.`);
  if (r.skipped.length) parts.push(`Not moved (${r.skipped.length}): ${r.skipped.map((s) => `${tokD(s.documentId)}: ${s.reason}`).join('; ')}.`);
  parts.push('Say in one line at the end of the answer what was moved or proposed.');
  return parts.join('\n');
}

/**
 * A lab value printed on a page into the lab table (2026-10-08, lab check). Asked for in the patient's message ("Can
 * you add it to the table?"): added at once by the app's own parser, never by the model's reading, with Undo under the
 * answer. Unasked: a proposal (a filings row, target lab_value) he approves with one press. The server refuses a line
 * that is not on that page, is not a lab result, or is unclear; the refusal comes back as the tool's error.
 */
function runAddLabValue(i: z.infer<typeof toolInputSchemas.add_lab_value_from_page>, ctx: ToolContext): string {
  const asked = askedInQuestion(i.askedInMessage, ctx.question, 'add');
  const input = { documentId: i.documentId, page: i.page, row: i.row?.trim() || null, quote: i.quote?.trim() || null, analyte: i.analyte?.trim() || null, askMessageId: ctx.askMessageId ?? null };
  if (asked) {
    const r = addLabValueFromPage({ ...input, by: 'clinician' });
    const added: AskLabValue = { factId: r.factId, documentId: i.documentId, page: i.page, words: r.words, outcome: r.outcome, undoable: Boolean(r.undo) };
    const list = (ctx.labValues ??= []);
    if (!list.some((x) => x.factId === added.factId)) list.push(added);
    // The service's own words (what was added, with its printed date, or why nothing new was added), then its tokens.
    const what = `${r.words} ${tokF(r.factId)} ${tokD(i.documentId, i.page)}`;
    const after = r.outcome === 'added' ? "Its detail says the clinician added it at the patient's request; Undo is under the answer." : 'Nothing new was added.';
    return [`As the patient asked ("${(i.askedInMessage ?? '').trim().slice(0, 200)}"):`, what, after, 'Say in one line at the end of the answer what was added.'].join('\n');
  }
  // The cap of unasked proposals is checked first, and counted only for a proposal actually made (a line refused as not
  // on the page or not a lab line does not use one of the five; 2026-10-09 review).
  if ((ctx.unsolicited ?? 0) + 1 > MAX_PROPOSALS_PER_ANSWER) takeUnsolicited(ctx, 1);
  const p = proposeLabValueFromPage(input);
  takeUnsolicited(ctx, 1);
  const proposals = (ctx.proposals ??= []);
  if (!proposals.includes(p.filingId)) proposals.push(p.filingId);
  return [`${p.words} The line: "${p.row.text}" ${tokD(i.documentId, i.page)}.`, 'Say in one line at the end of the answer what was proposed.'].join('\n');
}

/**
 * The clinician proposes computing a value (2026-10-09, D8): always a proposal (a filings row, target lab_compute) that
 * waits for the patient's yes, even when he asked; the app's own arithmetic and checks (services/lab-compute.ts). Each
 * input is named by its printed value's fact id; a detail that holds several tests needs the analyte.
 */
function runProposeComputed(i: z.infer<typeof toolInputSchemas.propose_computed_value>, ctx: ToolContext): string {
  const formula = FORMULAS[i.formula];
  const entries = loadLabEntries();
  const inputs: Record<string, string> = {};
  for (const x of i.inputs) {
    const slot = formula.slots.find((s) => s.id === x.slot);
    if (!slot) throw new Error(`${formula.name} has no input "${x.slot}"; its inputs are ${formula.slots.map((s) => s.id).join(', ')}`);
    let found = entries.filter((e) => e.factId === x.factId);
    if (!found.length) throw new Error(`no lab value with the detail ${x.factId} is listed (use the ⟦F:…⟧ token of a value from get_lab_series)`);
    if (found.length > 1 && slot.keys.length) found = found.filter((e) => slot.keys.includes(e.analyteKey));
    if (found.length > 1 && x.analyte) found = found.filter((e) => normalizeKey(e.analyte) === normalizeKey(x.analyte) || e.analyteKey === normalizeKey(x.analyte));
    if (found.length !== 1) throw new Error(`the detail ${x.factId} holds several tests; say which with analyte`);
    inputs[slot.id] = found[0].id;
  }
  if ((ctx.unsolicited ?? 0) + 1 > MAX_PROPOSALS_PER_ANSWER) takeUnsolicited(ctx, 1);
  const p = proposeComputedValue({ formula: i.formula, inputs, k: i.k ?? null, unit: i.unit ?? null, name: i.name ?? null }, { askMessageId: ctx.askMessageId ?? null, reason: i.reason });
  takeUnsolicited(ctx, 1);
  const proposals = (ctx.proposals ??= []);
  if (!proposals.includes(p.filingId)) proposals.push(p.filingId);
  const pages = p.preview.inputs.map((x) => (x.documentId && x.pageNumber ? tokD(x.documentId, x.pageNumber) : '')).filter(Boolean).join(' ');
  return [p.words, `Inputs: ${p.preview.inputs.map((x) => `${x.slotLabel} ${x.conversion ?? x.valueShown ?? ''}`).join('; ')} ${pages}.`, p.preview.pairing ? `Pairing: ${p.preview.pairing.words}.` : '', 'Say in one line at the end of the answer what was proposed, and that nothing is computed until he says yes.'].filter(Boolean).join('\n');
}

/** What the lab check found on a document, for get_document_coverage (times in the case's local time). */
function labCheckLines(r: LabCheckReport, documentId: string): string[] {
  const words = labCheckWords(r);
  const out: string[] = [
    `${words?.line ?? 'Lab check:'} (the app's own check, without the model: every lab result line on the pages Claude read, compared with the lab values on file; last run ${localStamp(r.at)}; ${n0(r.pagesChecked)} page${r.pagesChecked === 1 ? '' : 's'} checked, ${n0(r.pagesWithRows)} with lab lines)`,
  ];
  if (r.reread) {
    const state = r.reread.status === 'queued' ? 'being read again now' : r.reread.status === 'done' ? 'read again' : r.reread.status === 'failed' ? 'reading them again failed' : r.reread.status === 'ask' ? "reading them again waits for the patient's go-ahead" : 'not read again';
    const cost = r.reread.estimateUsd != null ? ` (about $${r.reread.estimateUsd.toFixed(2)}${r.reread.calls ? ` in ${n0(r.reread.calls)} small calls` : ''})` : '';
    out.push(`- pages with missed lines: ${formatPageRanges(pagesFromList(r.reread.pages))}, ${state}${cost} (${localStamp(r.reread.at)})${r.reread.reason ? `: ${r.reread.reason}` : ''}`);
  }
  for (const a of r.added.slice(0, 40)) {
    // A value the patient took back (Undo) is said so, with no token to a value that is gone; it is never added again.
    if (a.undone) out.push(`- taken back by the patient (Undo), not to be added again: p.${a.page} "${a.text}" ${tokD(documentId, a.page)}`);
    else out.push(`- added from the page ${a.by === 'clinician' ? 'by the clinician at the patient\'s request' : 'by the lab check'} (${localStamp(a.at)}): p.${a.page} "${a.text}" ${tokF(a.factId)} ${tokD(documentId, a.page)}`);
  }
  if (r.added.length > 40) out.push(`- and ${n0(r.added.length - 40)} more added from the page`);
  for (const m of r.missedRows.slice(0, 60)) out.push(`- still missing: p.${m.page} "${m.text}" ${tokD(documentId, m.page)} (add_lab_value_from_page adds it)`);
  if (r.missed > Math.min(60, r.missedRows.length)) out.push(`- and ${n0(r.missed - Math.min(60, r.missedRows.length))} more lines still missing`);
  if (r.deletedByYou) out.push(`- ${n0(r.deletedByYou)} line${r.deletedByYou === 1 ? '' : 's'} left alone because the patient deleted the value that held ${r.deletedByYou === 1 ? 'it' : 'them'}`);
  // Pages whose lines the app did not add by itself (its sanity test): the reason, the page; add_lab_value_from_page
  // still adds a line he asks for, after checking it on the page.
  for (const h of (r.heldBack ?? []).slice(0, 30)) out.push(`- not added by itself: p.${h.page} (${n0(h.rows)} line${h.rows === 1 ? '' : 's'}): ${h.reason} ${tokD(documentId, h.page)}`);
  for (const n of r.notes.slice(0, 10)) out.push(`- ${n}`);
  return out;
}

function chartLine(n: number, spec: ChartSpec): string {
  const xs = spec.series.flatMap((s) => s.points.map((p) => String(p.x)));
  const years = xs.map((x) => x.slice(0, 4)).filter((y) => /^\d{4}$/.test(y)).sort();
  const k = spec.series.reduce((m, s) => m + s.points.length, 0);
  const span = years.length ? ` from ${years[0]} to ${years[years.length - 1]}` : '';
  return `Chart ${n}: ${spec.title ?? 'untitled'} (${k} point${k === 1 ? '' : 's'}${span}). Refer to it in the answer as [chart:${n}].`;
}

/** Plain words for a flag, said beside a result so an abnormal or positive one stands out. */
const FLAG_WORDS: Record<string, string> = { H: 'high', L: 'low', A: 'abnormal', C: 'critical', N: 'normal' };

/**
 * One result in words: "2024-06-01 Positive (abnormal)", "2022-01-05 Clear", "2024-03-18 <2 (a limit: below 2)". The
 * flag is the one printed with it (a document's own flag said as its claim), never one worked out from a range.
 */
function resultWords(r: LabRow): string {
  const v = r.reading;
  const shown = v ? v.valueShown : (r.valueText ?? (r.value != null ? String(r.value) : '?'));
  const unit = v ? v.unit : r.unit;
  const value = `${shown.trim()}${unit ? ` ${unit}` : ''}`;
  const limit = v?.kind === 'censored' && v.limit ? ` (a limit: ${v.limit})` : '';
  const printed = v ? (v.flagState === 'flag' ? (v.flagPrinted ?? null) : null) : r.flag;
  const flag = printed ? (FLAG_WORDS[printed.trim().toUpperCase()] ?? printed) : null;
  const claim = v?.role === 'claimed' ? ', as this document says' : '';
  return `${fmtDate(r.date, r.datePrecision)} ${value}${limit}${flag && flag !== 'normal' ? ` (${flag}${claim})` : ''}`;
}

function runChartLabSeries(input: z.infer<typeof toolInputSchemas.chart_lab_series>, ctx: ToolContext): string {
  const q = { analyte: input.analyte, specimen: input.specimen ?? null, from: input.from ?? null, to: input.to ?? null };
  const entries = loadLabEntries();
  const rows = labSeries(q, entries);
  if (!rows.length) {
    const unmatched = unmatchedAnswer(input, entries);
    if (unmatched) return `${unmatched} No chart was made.`;
  }
  const name = analyteLabel(rows[0]?.analyteKey ?? '', mostCommonText(rows.map((r) => r.analyte)) ?? input.analyte) || input.analyte;
  // A test whose results are all words or limits gets no chart: its results, in words, each with its row (and source).
  if (isWordOnly(rows.map((r) => ({ valueNum: r.value, valueText: r.valueText, reading: r.reading ?? undefined })))) {
    return [`${name} has no numeric results; its results are: ${rows.map(resultWords).join(', ')}. No chart was made; give these results in words.`, `Rows (${LAB_ROW_FORMAT}):`, ...rows.map(labRowLine)].join('\n');
  }
  const dated = rows.filter((r) => r.date);
  if (!dated.length) return `No dated stored results for "${input.analyte}"; nothing to chart. ${runLabSeries({ analyte: input.analyte, specimen: input.specimen, from: input.from, to: input.to })}`;
  const spec = labsBuildLabChart({ ...seriesQuery(q), overlayMedications: Boolean(input.overlayMedications), title: input.title ?? null }, entries);
  const measured = (r: LabRow) => (r.reading ? r.reading.kind === 'number' && r.reading.measurement != null : r.value != null);
  if (!spec) {
    // Numbers, but none that can be drawn: no chart, never an empty one. Each value's own reason is said (a limit, words,
    // a range, marked inaccurate, undated), never one reason for all.
    return [`Nothing to chart for ${name}: no value in this range can be drawn (${notDrawnReasons(rows, measured)}). No chart was made. Its results are: ${rows.map(resultWords).join(', ')}.`, `Rows (${LAB_ROW_FORMAT}):`, ...rows.map(labRowLine)].join('\n');
  }
  // One chart per unit (rule 5): 3659 mg/dL and 4.4 g/dL are never drawn against one axis. Nothing is converted or relabelled.
  const specs = chartsPerUnit(spec);
  const lines: string[] = [];
  for (const s of specs) {
    ctx.charts.push(s);
    const n = ctx.charts.length;
    ctx.onChart?.(s, n);
    lines.push(chartLine(n, s));
  }
  // The chart draws measurements only (services/labs.ts buildLabChart): values marked inaccurate (they contradict a
  // clinical record or the patient's correction), limits ("<3": never a measurement), results in words and undated
  // values are listed apart, with their markers.
  const plotted = dated.filter((r) => measured(r) && r.trust?.trust !== 'inaccurate');
  const apart = rows.filter((r) => !plotted.includes(r));
  const perUnit = specs.length > 1 ? `\nThe values come in ${specs.length} units, so there is one chart per unit (nothing converted or relabelled); refer to each.` : '';
  return `${lines.join('\n')}${perUnit}${spec.note ? `\nChart note: ${spec.note}` : ''}\nValues plotted:\n${plotted.map(labRowLine).join('\n') || '(none)'}${apart.length ? `\nNot plotted (marked inaccurate, not a number, or undated):\n${apart.map(labRowLine).join('\n')}` : ''}`;
}

/** Why these values are not drawn, counted by reason: "1 limit (not a measurement), 1 value marked inaccurate". */
function notDrawnReasons(rows: LabRow[], measured: (r: LabRow) => boolean): string {
  const WORDS: Record<string, [string, string]> = {
    limit: ['limit (not a measurement)', 'limits (not measurements)'],
    words: ['result in words', 'results in words'],
    range: ['value printed as a range', 'values printed as a range'],
    other: ['value that is not a number', 'values that are not numbers'],
    inaccurate: ['value marked inaccurate', 'values marked inaccurate'],
    undated: ['undated value', 'undated values'],
  };
  const count = new Map<string, number>();
  const add = (k: string) => count.set(k, (count.get(k) ?? 0) + 1);
  for (const r of rows) {
    const kind = r.reading?.kind;
    if (kind === 'censored') add('limit');
    else if (kind === 'text' || kind === 'empty') add('words');
    else if (kind === 'range') add('range');
    else if (!measured(r)) add('other');
    else if (r.trust?.trust === 'inaccurate') add('inaccurate');
    else if (!r.date) add('undated');
  }
  return [...count.entries()].map(([k, n]) => `${n} ${WORDS[k][n === 1 ? 0 : 1]}`).join(', ') || 'none can be drawn';
}

/**
 * A lab chart whose series come in several units, as one chart per unit (each with its own y axis and its unit in the
 * title), as the Labs page, the packet and the brief draw it. The band stays with the series it was drawn for (the
 * first unit); the note goes under the last chart; medication rows go on each. One unit: the chart as it is.
 */
function chartsPerUnit(spec: ChartSpec): ChartSpec[] {
  const units: string[] = [];
  const byUnit = new Map<string, ChartSpec['series']>();
  for (const s of spec.series) {
    const k = unitKey(s.unit ?? null) ?? '';
    if (!byUnit.has(k)) {
      units.push(k);
      byUnit.set(k, []);
    }
    byUnit.get(k)!.push(s);
  }
  if (units.length <= 1) return [spec];
  const base = (spec.title ?? '').trim();
  return units.map((k, i) => {
    const series = byUnit.get(k)!;
    const shown = series.find((s) => s.unit)?.unit ?? null;
    const unitWords = shown ?? 'no unit printed';
    const n = series.reduce((m, s) => m + s.points.filter((p) => p.y != null).length, 0);
    return {
      ...spec,
      title: base ? `${base} · ${unitWords}` : unitWords,
      subtitle: `${n} value${n === 1 ? '' : 's'} in ${unitWords}`,
      yLabel: shown,
      series,
      referenceBand: i === 0 ? (spec.referenceBand ?? null) : null,
      note: i === units.length - 1 ? (spec.note ?? null) : null,
    };
  });
}

function runMakeChart(input: Record<string, unknown>, ctx: ToolContext): string {
  const raw: Record<string, unknown> = { ...input };
  if (Array.isArray(raw.yDomain)) raw.yDomain = raw.yDomain.length === 2 && raw.yDomain.every((v) => typeof v === 'number') ? [raw.yDomain[0], raw.yDomain[1]] : null;
  if (raw.yDomain === 'auto') raw.yDomain = null;
  raw.source = 'model';
  const parsed = chartSpec.safeParse(raw);
  if (!parsed.success) throw new Error(`chart did not validate: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const spec = parsed.data;
  ctx.charts.push(spec);
  const n = ctx.charts.length;
  ctx.onChart?.(spec, n);
  return `${chartLine(n, spec)} The chart is labelled as assembled by the model; cite the source of every value in the answer.`;
}

const MAX_PROPOSALS_PER_ANSWER = 5;

function runProposeRefile(i: z.infer<typeof toolInputSchemas.propose_refile>, ctx: ToolContext): string {
  const proposals = (ctx.proposals ??= []);
  takeUnsolicited(ctx, 1);
  const f = proposeMove({ documentId: i.documentId, toCategory: i.toCategory, reason: i.reason, askMessageId: ctx.askMessageId ?? null });
  if (!proposals.includes(f.id)) proposals.push(f.id);
  return `Proposed: ${f.summary} The patient will approve or decline it in the thread; nothing has changed yet.`;
}

/** Validate and run one tool. Errors become `isError: true` text, never exceptions. */
export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const summary = toolSummary(name, input);
  const schemaFor = (toolInputSchemas as Record<string, z.ZodTypeAny>)[name];
  if (!schemaFor) return { text: `Unknown tool ${name}. Available: ${TOOL_NAMES.join(', ')}.`, isError: true, summary };
  const parsed = schemaFor.safeParse(input ?? {});
  if (!parsed.success) return { text: `Invalid input for ${name}: ${zodIssues(parsed.error, 'input')}`, isError: true, summary };
  try {
    let text: string;
    switch (name as ToolName) {
      case 'search_case':
        text = runSearch(parsed.data as z.infer<typeof toolInputSchemas.search_case>);
        break;
      case 'get_facts':
        text = runFacts(parsed.data as z.infer<typeof toolInputSchemas.get_facts>);
        break;
      case 'get_lab_series':
        text = runLabSeries(parsed.data as z.infer<typeof toolInputSchemas.get_lab_series>);
        break;
      case 'get_document_pages':
        text = runDocumentPages(parsed.data as z.infer<typeof toolInputSchemas.get_document_pages>);
        break;
      case 'get_timeline':
        text = runTimeline(parsed.data as z.infer<typeof toolInputSchemas.get_timeline>);
        break;
      case 'get_communications':
        text = runCommunications(parsed.data as z.infer<typeof toolInputSchemas.get_communications>);
        break;
      case 'list_documents':
        text = runListDocuments(parsed.data as z.infer<typeof toolInputSchemas.list_documents>);
        break;
      case 'chart_lab_series':
        text = runChartLabSeries(parsed.data as z.infer<typeof toolInputSchemas.chart_lab_series>, ctx);
        break;
      case 'make_chart':
        text = runMakeChart(parsed.data as Record<string, unknown>, ctx);
        break;
      case 'propose_refile':
        text = runProposeRefile(parsed.data as z.infer<typeof toolInputSchemas.propose_refile>, ctx);
        break;
      case 'get_document_coverage':
        text = runDocumentCoverage(parsed.data as z.infer<typeof toolInputSchemas.get_document_coverage>);
        break;
      case 'get_document_outline':
        text = runDocumentOutline(parsed.data as z.infer<typeof toolInputSchemas.get_document_outline>);
        break;
      case 'get_thread':
        text = runThread(parsed.data as z.infer<typeof toolInputSchemas.get_thread>);
        break;
      case 'propose_reprocess_many':
        text = runProposeReprocessMany(parsed.data as z.infer<typeof toolInputSchemas.propose_reprocess_many>, ctx);
        break;
      case 'propose_refile_many':
        text = runProposeRefileMany(parsed.data as z.infer<typeof toolInputSchemas.propose_refile_many>, ctx);
        break;
      case 'add_lab_value_from_page':
        text = runAddLabValue(parsed.data as z.infer<typeof toolInputSchemas.add_lab_value_from_page>, ctx);
        break;
      case 'propose_computed_value':
        text = runProposeComputed(parsed.data as z.infer<typeof toolInputSchemas.propose_computed_value>, ctx);
        break;
      case 'get_current_plan':
        text = planForClinician((parsed.data as z.infer<typeof toolInputSchemas.get_current_plan>).planId ?? null);
        break;
      case 'get_medication_timeline':
        text = medicationTimelineText((parsed.data as z.infer<typeof toolInputSchemas.get_medication_timeline>).drug);
        break;
      default:
        text = `Unknown tool ${name}.`;
    }
    return { text: cap(text), isError: false, summary };
  } catch (err) {
    return { text: `${name} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true, summary };
  }
}
