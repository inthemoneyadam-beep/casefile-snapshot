/**
 * Checked against itself (2026-10-09; lead's section B): a newly added document is checked against itself only,
 * never against the rest of the case.
 *
 * 1. Lab flags (no AI, `runFlagCheck`): every lab value of the document whose printed flag disagrees with its own
 *    printed range and value (shared/selfcheck.ts flagMismatchOf: L above the range, H below it, H or L inside it; a
 *    clinical record's measurement only, a range read as numbers in the same unit). One finding per document listing
 *    each row, as rule 12 groups its differences (kind `flag_mismatch`, rule `flag_mismatch`).
 * 2. Contradictions (Claude, `selfCheckJob`): each part of the document (a note, a visit, a letter; a document read
 *    before parts existed is cut into blocks of pages) is read in small calls for passages that cannot both be true.
 *    Each contradiction quotes BOTH passages with their pages (verified against the page text, stored and in reading
 *    order; one not found word for word is kept and flagged, never dropped) and its kind. One finding each (kind
 *    `contradicts_itself`, rule `self_contradiction`, origin ai), worded without a diagnosis and without saying who is
 *    right. No rules run ever clears one (they clear origin rule only).
 *
 * When: at the end of every reading pass of a NEW upload (a document added since this check first ran, setting
 * `selfCheck.since`, from a clinical record or a document not sorted yet), and afterwards for any document already
 * checked (only parts whose text changed are read again). An existing document only when the user asks ("Check it against
 * itself", for one or many). Automatic checks run under the per-document limit `ai.autoResumeCeilingUsd`; above it
 * Claude asks once and "Not now" is kept. The user's own request runs at the cost the screen showed him first.
 *
 * Each finding is titled with the document's institution ("From Valley Clinic: ..."), and the counts per institution
 * are on People and places and on the document's "How much was read" panel. No duplicates: a candidate whose evidence
 * an existing finding already holds (rule 10 or 12, the precedence rule, Claude's Deep check, or this check itself)
 * is not raised again. The record per document is `documents.metadata_json.selfCheck` (one writer: this module).
 * Every AI call goes through ai/client.ts (purpose `self_check`, in the AI usage log) and every pass that wrote or
 * cleared a finding is one row of Past checks (crossref_runs, rule `self_check`). No schema change.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { newId, normalizeKey, nowIso, parseJson, sha256 } from '../util/ids';
import { notFound } from '../util/errors';
import { getSetting, setSetting } from './settings';
import { liveDocumentRow } from './document-rows';
import { loadLabReadings } from './labs';
import { listSegments, pageTextFormsLookup, segmentPageTexts, type SegmentRow } from './segments';
import { applyDrafts, AUTO_CLEARED_PREFIX, createRun, draftsAlreadyApplied, fingerprintOf, finishRun, isUserNote, retireStaleRuleFindings } from './findings';
import { onDocumentDeletedOrRestored, onSourceTierChange } from './documents';
import type { CrossrefScope, DraftEvidence, FindingDraft } from './crossref-rules';
import type { LabReadingRecord } from './lab-reading';
import { aiEnabled, AiDisabledError, callStructured, getApiKey, NoApiKeyError } from '../ai/client';
import { looksLikeDiagnosis } from '../ai/crossref';
import { isVerifiedMatch, locateQuote, normalizeText, storedMatchKind, textSimilarity } from '../ai/citations';
import { buildSelfCheckUserMessage, SELF_CHECK_SYSTEM_PROMPT, selfCheckOutput, type SelfCheckAiContradiction, type SelfCheckOutput } from '../ai/prompts/self-check';
import { enqueueJob, JobCancelledError, type JobContext } from '../jobs/queue';
import { MODEL_PRICES, type Effort, type SettingKey, type Settings } from '../../shared/constants';
import { routeOf, parseSegmentDetail } from '../../shared/schemas/segments';
import {
  CONTRADICTION_CATEGORY, CONTRADICTION_RULE, FLAG_MISMATCH_CATEGORY, FLAG_MISMATCH_RULE, SELF_CHECK_RUN_RULE, SELF_CHECK_VERSION, contradictionKindWords,
  countsWords, facilityWords, flagCheckable, flagMismatchOf, flagMismatchWords, plural, selfCheckOf, type ContradictionKind, type FlagMismatch, type SelfCheckPartRecord, type SelfCheckRecord,
} from '../../shared/selfcheck';

// ---------------------------------------------------------------------------
// Settings and limits
// ---------------------------------------------------------------------------

/** The moment this check first ran on this case: documents added from then on are new uploads (checked by themselves). */
export const SELF_CHECK_SINCE_SETTING = 'selfCheck.since';
/**
 * Effort for the contradiction calls: medium. Finding two passages of a note that cannot both be true means holding
 * the history, the exam and the assessment side by side and setting aside changes over time, which is reasoning, not
 * transcription (the reading itself uses low). The calls are small (one part, or a few short ones), so medium adds
 * little in dollars; high would add thinking where the answer is usually "nothing contradicts".
 */
export const SELF_CHECK_EFFORT: Effort = 'medium';
/** Characters of page text one call holds at most, and parts packed into one call at most. */
export const SELF_CHECK_CALL_CHARS = 24_000;
export const SELF_CHECK_PARTS_PER_CALL = 6;
/** For the estimate: tokens a call adds besides its pages (system prompt, head), and its answer (thinking + JSON). */
export const SELF_CHECK_CALL_OVERHEAD_TOKENS = 1_500;
export const SELF_CHECK_OUTPUT_TOKENS = 2_000;
const TOKEN_CHARS = 4;
/** Parts never read for contradictions: repeated furniture, handouts, pictures, the patient's own messages and forms, and tables over time. */
const SKIPPED_KINDS = new Set(['boilerplate', 'education', 'media', 'messages', 'appointment_request', 'questionnaire', 'patient_entered', 'flowsheets', 'vitals', 'mar']);
/** Tiers checked by themselves when new: a clinical record, or a document not sorted yet. Any tier when the user asks. */
const AUTOMATIC_TIERS = new Set(['primary', 'unknown']);

/** The moment on file, or null before the first unlock with this check (reads only). */
export function readSelfCheckSince(): string | null {
  const v = getSetting(SELF_CHECK_SINCE_SETTING as SettingKey) as unknown;
  return typeof v === 'string' && v ? v : null;
}

/** The moment on file, set to now when missing (at every unlock, src/server/index.ts, before any upload can arrive). */
export function selfCheckSince(): string {
  const v = readSelfCheckSince();
  if (v) return v;
  const now = nowIso();
  setSetting(SELF_CHECK_SINCE_SETTING as SettingKey, now as unknown as Settings[SettingKey]);
  return now;
}

/** The per-document limit for automatic readings (Settings, "Carry on reading up to"; 0 = always ask). */
export function selfCheckCeiling(): number {
  const n = Number(getSetting('ai.autoResumeCeilingUsd'));
  return Number.isFinite(n) && n >= 0 ? n : 50;
}

function underCeiling(usd: number): boolean {
  const c = selfCheckCeiling();
  return c > 0 && usd <= c;
}

/**
 * A yes given to a cost covers that cost and up to a quarter more (as a yes to reading the rest does, ai/extraction.ts
 * approvalCovers); above that the check asks again rather than spend past the limit on an old yes (review 2026-10-09).
 */
export function approvalCovers(approvedUsd: number | null | undefined, usd: number): boolean {
  return typeof approvedUsd === 'number' && Number.isFinite(approvedUsd) && usd <= approvedUsd * 1.25 + 0.01;
}

function aiReady(): boolean {
  try {
    return aiEnabled() && Boolean(getApiKey());
  } catch {
    return false;
  }
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// The record on the document (metadata_json.selfCheck)
// ---------------------------------------------------------------------------

type DocRow = typeof schema.documents.$inferSelect;

export function readSelfCheck(documentId: string): SelfCheckRecord | null {
  const row = db().select({ metadataJson: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
  return row ? selfCheckOf(row.metadataJson) : null;
}

/** One synchronous read-modify-write of `metadata_json.selfCheck`, every other key kept. */
export function patchSelfCheck(documentId: string, fn: (prev: SelfCheckRecord) => SelfCheckRecord): SelfCheckRecord | null {
  let out: SelfCheckRecord | null = null;
  db().transaction((tx) => {
    const row = tx.select({ metadataJson: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    if (!row) return;
    const meta = parseJson<Record<string, unknown>>(row.metadataJson, {});
    const prev = (meta.selfCheck && typeof meta.selfCheck === 'object' ? meta.selfCheck : {}) as SelfCheckRecord;
    out = fn(prev);
    tx.update(schema.documents).set({ metadataJson: JSON.stringify({ ...meta, selfCheck: out }) }).where(eq(schema.documents.id, documentId)).run();
  });
  return out;
}

function emptyContradictions(): NonNullable<SelfCheckRecord['contradictions']> {
  return { version: SELF_CHECK_VERSION, state: 'none', at: nowIso(), parts: {}, found: 0, raised: 0, alreadyRaised: 0, setAside: 0, unverified: 0 };
}

function patchContradictions(documentId: string, patch: Partial<NonNullable<SelfCheckRecord['contradictions']>>): void {
  patchSelfCheck(documentId, (prev) => ({ ...prev, contradictions: { ...(prev.contradictions ?? emptyContradictions()), ...patch, at: nowIso() } }));
}

/** A new upload: added since this check first ran, from a clinical record or a document not sorted yet. */
export function isNewUpload(doc: Pick<DocRow, 'createdAt' | 'sourceTier'>, since: string | null = readSelfCheckSince()): boolean {
  return Boolean(since) && doc.createdAt >= since! && AUTOMATIC_TIERS.has(doc.sourceTier || 'unknown');
}

/**
 * Whether a checked document is read again by itself after a later reading: a clinical record or one not sorted yet,
 * or any document the user asked for himself. A new upload sorted (or marked by hand) as a summary, an outside letter or
 * his own notes since is not (review 2026-10-09): its flags are its claims, and his notes are not a facility's record.
 */
function checksByItself(doc: Pick<DocRow, 'sourceTier'>, rec: SelfCheckRecord | null): boolean {
  return rec?.trigger === 'user' || AUTOMATIC_TIERS.has(doc.sourceTier || 'unknown');
}

/** The scope of a self-check run in Past checks: how it started and which document (never a scope that filters). */
function runScopeFor(trigger: string, documentId: string): CrossrefScope {
  const scope: CrossrefScope & { trigger: string; rule: string; triggeredByDocumentId: string } = { trigger, rule: SELF_CHECK_RUN_RULE, triggeredByDocumentId: documentId };
  return scope;
}

export interface Facility {
  /** The People and places row (a hospital or clinic), when the document is linked to one or names one on the list. */
  id: string | null;
  /** Its name, or the place as the document's sorting or reading wrote it. */
  name: string | null;
  /** Where the name came from: the document's own link, Claude's sorting, or Claude's reading. */
  source: 'linked' | 'sorting' | 'reading' | null;
}

type PlaceIndex = Map<string, { id: string; name: string }>;

/** Hospitals and clinics on People and places by every name they go by (normalised). */
function placeIndex(): PlaceIndex {
  const out: PlaceIndex = new Map();
  const rows = db()
    .select({ id: schema.people.id, name: schema.people.name, aliasesJson: schema.people.aliasesJson })
    .from(schema.people)
    .where(and(isNull(schema.people.deletedAt), inArray(schema.people.kind, ['institution', 'clinic'])))
    .all();
  for (const r of rows) {
    for (const n of [r.name, ...parseJson<string[]>(r.aliasesJson, [])]) {
      const k = normalizeKey(n ?? '');
      if (k && !out.has(k)) out.set(k, { id: r.id, name: r.name });
    }
  }
  return out;
}

function personName(id: string | null | undefined): string | null {
  if (!id) return null;
  return db().select({ name: schema.people.name }).from(schema.people).where(and(eq(schema.people.id, id), isNull(schema.people.deletedAt))).get()?.name ?? null;
}

/**
 * The facility a document came from: its institution (People and places) when it is linked to one; else the place
 * Claude's sorting named (a row on the list, or the name as written), else the institution Claude's reading wrote. A
 * name that matches a hospital or clinic on the list (by name or another name it goes by) is that row.
 */
export function facilityOf(doc: Pick<DocRow, 'institutionId' | 'metadataJson'>, index: PlaceIndex = placeIndex()): Facility {
  if (doc.institutionId) {
    const name = personName(doc.institutionId);
    if (name) return { id: doc.institutionId, name, source: 'linked' };
  }
  const meta = parseJson<Record<string, unknown>>(doc.metadataJson, {});
  const triage = (meta.triage ?? null) as { institution?: { match_id?: string | null; new_name?: string | null } } | null;
  const matched = personName(triage?.institution?.match_id ?? null);
  if (matched) return { id: triage!.institution!.match_id!, name: matched, source: 'sorting' };
  const named: Array<[string | null | undefined, Facility['source']]> = [
    [triage?.institution?.new_name, 'sorting'],
    [(meta.extraction as { institution?: string | null } | undefined)?.institution, 'reading'],
  ];
  for (const [raw, source] of named) {
    const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
    if (!name) continue;
    const hit = index.get(normalizeKey(name));
    return hit ? { id: hit.id, name: hit.name, source } : { id: null, name: clip(name, 120), source };
  }
  return { id: null, name: null, source: null };
}

/** The title's lead: "From Valley Clinic" or, with no facility named anywhere, the document itself. */
function lead(doc: Pick<DocRow, 'title' | 'institutionId' | 'metadataJson'>): string {
  const f = facilityOf(doc);
  return f.name ? facilityWords(f.name) : `In "${clip(doc.title, 60)}"`;
}

// ---------------------------------------------------------------------------
// Evidence already on file (no duplicates)
// ---------------------------------------------------------------------------

interface OnFileEvidence {
  findingId: string;
  ruleId: string | null;
  category: string;
  factId: string | null;
  labResultId: string | null;
  citation: { documentId: string; pageNumber: number; norm: string } | null;
}

/** Every live finding's evidence that touches this document (by its own column, a citation on it, or a fact read from it). */
function evidenceOnDocument(documentId: string): OnFileEvidence[] {
  const rows = db().all<{ findingId: string; ruleId: string | null; category: string; factId: string | null; labResultId: string | null; cDoc: string | null; cPage: number | null; cQuote: string | null }>(sql`
    select fe.finding_id as findingId, f.rule_id as ruleId, f.category as category, fe.fact_id as factId, fe.lab_result_id as labResultId,
           c.document_id as cDoc, c.page_number as cPage, c.quote as cQuote
    from finding_evidence fe
    join findings f on f.id = fe.finding_id and f.deleted_at is null
    left join citations c on c.id = fe.citation_id
    left join facts fa on fa.id = fe.fact_id
    left join lab_results lr on lr.id = fe.lab_result_id
    where fe.document_id = ${documentId} or c.document_id = ${documentId} or fa.source_document_id = ${documentId} or lr.document_id = ${documentId}`);
  return rows.map((r) => ({
    findingId: r.findingId,
    ruleId: r.ruleId,
    category: r.category,
    factId: r.factId,
    labResultId: r.labResultId,
    citation: r.cDoc && r.cPage != null && r.cQuote ? { documentId: r.cDoc, pageNumber: r.cPage, norm: normalizeText(r.cQuote) } : null,
  }));
}

/** Two passages are the same when one holds the other or they read nearly alike (normalised text). */
export function passagesOverlap(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  return textSimilarity(a, b) >= 0.8;
}

// ---------------------------------------------------------------------------
// 1. Lab flags (no AI)
// ---------------------------------------------------------------------------

export interface FlagRow {
  id: string;
  factId: string | null;
  labResultId: string | null;
  citationId: string | null;
  analyte: string;
  pageNumber: number | null;
  mismatch: FlagMismatch;
}

export interface FlagCheckResult {
  checked: number;
  rows: FlagRow[];
  alreadyRaised: number;
  draft: FindingDraft | null;
  runId: string | null;
  created: number;
  updated: number;
  retired: number;
  findingId: string | null;
}

/** The document's lab values whose printed flag doesn't match (and how many could be checked at all). */
export function flagRowsOf(documentId: string, readings: readonly LabReadingRecord[] = loadLabReadings()): { checked: number; rows: FlagRow[] } {
  const rows: FlagRow[] = [];
  let checked = 0;
  for (const r of readings) {
    if (r.documentId !== documentId || r.passSetAside) continue;
    const rd = r.reading;
    if (flagCheckable(rd)) checked++;
    const m = flagMismatchOf(rd);
    if (m) rows.push({ id: r.id, factId: r.factId, labResultId: r.labResultId, citationId: r.citationId, analyte: r.analyte, pageNumber: r.pageNumber, mismatch: m });
  }
  rows.sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0) || a.analyte.localeCompare(b.analyte) || a.id.localeCompare(b.id));
  return { checked, rows };
}

/** A row another finding already names: a disagreement (rule 10 or 12, the precedence rule, the Deep check) citing that very value. */
function rowAlreadyRaised(row: FlagRow, onFile: readonly OnFileEvidence[]): boolean {
  return onFile.some((e) => e.ruleId !== FLAG_MISMATCH_RULE && e.category === 'discrepancy' && ((row.factId && e.factId === row.factId) || (row.labResultId && e.labResultId === row.labResultId)));
}

/** One row in words, with its page: "Sodium: 141 mmol/L is marked L (low), but ... (135-140). Page 1." */
function rowWords(r: FlagRow): string {
  return `${flagMismatchWords(r.analyte, r.mismatch)}${r.pageNumber != null ? ` Page ${r.pageNumber}.` : ''}`;
}

/** The one finding of a document's flags that don't match (null when none is left to raise). */
export function flagDraftOf(doc: Pick<DocRow, 'id' | 'title' | 'institutionId' | 'metadataJson'>, rows: readonly FlagRow[]): FindingDraft | null {
  if (!rows.length) return null;
  const n = rows.length;
  const reversed = rows.some((r) => r.mismatch.byRange !== 'N' || r.mismatch.critical);
  const evidence: DraftEvidence[] = rows.map((r) => ({ factId: r.factId, labResultId: r.labResultId, citationId: r.citationId, documentId: doc.id, note: clip(rowWords(r), 400) }));
  return {
    ruleId: FLAG_MISMATCH_RULE,
    category: FLAG_MISMATCH_CATEGORY,
    severity: reversed ? 'medium' : 'low',
    title: clip(`${lead(doc)}: the flag on ${plural(n, 'lab value')} doesn't match the value`, 140),
    whyItMatters:
      'The report marks these values high or low, but each value and the range printed with it say otherwise. A wrong flag can make a normal result look abnormal, or hide an abnormal one. Nothing was changed: the value, the range and the flag stay as printed. The lab or the clinic can say which is right.',
    detail: [`In "${clip(doc.title, 120)}":`, ...rows.map(rowWords)].join('\n'),
    evidence,
    key: [doc.id],
  };
}

/** The finding a draft was written to (by its fingerprint), or null. */
function findingIdOf(draft: FindingDraft): string | null {
  return db().select({ id: schema.findings.id }).from(schema.findings).where(eq(schema.findings.fingerprint, fingerprintOf(draft))).get()?.id ?? null;
}

/** Open flag findings (status new): all, each marked whether its evidence is on this document. */
function openFlagFindings(documentId: string): Array<{ fingerprint: string | null; verdictNote: string | null; onDocument: boolean }> {
  const f = schema.findings;
  const rows = db().select({ id: f.id, fingerprint: f.fingerprint, verdictNote: f.verdictNote }).from(f).where(and(eq(f.ruleId, FLAG_MISMATCH_RULE), eq(f.status, 'new'), isNull(f.deletedAt))).all();
  if (!rows.length) return [];
  const on = new Set(db().all<{ id: string }>(sql`select distinct finding_id as id from finding_evidence where document_id = ${documentId}`).map((r) => r.id));
  return rows.map((r) => ({ fingerprint: r.fingerprint, verdictNote: r.verdictNote, onDocument: on.has(r.id) }));
}

/**
 * The flag check of one document, stored as at most one finding. A pass that would change nothing makes no run row.
 * Only this document's open flag finding that no longer holds is cleared (never one the user answered or wrote on).
 */
export function runFlagCheck(documentId: string, opts: { trigger?: 'upload' | 'user' } = {}): FlagCheckResult {
  const doc = liveDocumentRow(documentId);
  if (!doc) throw notFound('document not found');
  const { checked, rows: all } = flagRowsOf(documentId);
  const onFile = all.length ? evidenceOnDocument(documentId) : [];
  const rows = all.filter((r) => !rowAlreadyRaised(r, onFile));
  const draft = flagDraftOf(doc, rows);
  const drafts = draft ? [draft] : [];
  const out: FlagCheckResult = { checked, rows, alreadyRaised: all.length - rows.length, draft, runId: null, created: 0, updated: 0, retired: 0, findingId: null };
  const open = openFlagFindings(documentId);
  const applied0 = draftsAlreadyApplied(drafts);
  const active = new Set(applied0.fingerprints);
  const wouldRetire = open.some((o) => o.onDocument && (!o.fingerprint || !active.has(o.fingerprint)) && !isUserNote(o.verdictNote));
  if (!(applied0.same && !wouldRetire)) {
    const run = createRun({ rulesOnly: true, scope: runScopeFor(opts.trigger ?? 'upload', documentId) });
    out.runId = run.id;
    try {
      const applied = applyDrafts(run.id, 'rule', drafts);
      const keep = [...applied.fingerprints, ...open.filter((o) => !o.onDocument && o.fingerprint).map((o) => o.fingerprint!)];
      out.retired = retireStaleRuleFindings(run.id, keep, [FLAG_MISMATCH_RULE]);
      out.created = applied.created;
      out.updated = applied.updated;
      db().update(schema.crossrefRuns).set({ rulesCount: applied.created + applied.updated + applied.unchanged }).where(eq(schema.crossrefRuns.id, run.id)).run();
      finishRun(run.id, { status: 'done' });
    } catch (err) {
      finishRun(run.id, { status: 'failed', error: messageOf(err) });
      throw err;
    }
  }
  if (draft) out.findingId = findingIdOf(draft);
  patchSelfCheck(documentId, (prev) => ({
    ...prev,
    trigger: prev.trigger ?? opts.trigger ?? 'upload',
    flags: { version: SELF_CHECK_VERSION, at: nowIso(), checked, mismatched: all.length, alreadyRaised: out.alreadyRaised, findingId: out.findingId },
  }));
  return out;
}

// ---------------------------------------------------------------------------
// 2. Contradictions: parts, calls, the estimate
// ---------------------------------------------------------------------------

export interface CheckPart {
  /** The key its record is kept under: the segment id ("#2" for the second block of a long one), or "pages:a-b". */
  key: string;
  segmentId: string | null;
  label: string | null;
  pages: Array<{ pageNumber: number; text: string }>;
  chars: number;
  hash: string;
}

export interface CheckCall {
  parts: CheckPart[];
  chars: number;
}

export interface ContradictionPlan {
  /** Every part that can be read for contradictions. */
  eligible: number;
  /** The parts to read now. */
  parts: CheckPart[];
  calls: CheckCall[];
  characters: number;
  estimateUsd: number;
  model: string;
}

function partLabel(seg: SegmentRow): string | null {
  const bits = [seg.headerText, seg.encounterType && !(seg.headerText ?? '').includes(seg.encounterType) ? seg.encounterType : null, seg.encounterDateText].filter((x): x is string => Boolean(x && x.trim()));
  return bits.length ? clip(bits.join(', '), 160) : null;
}

/** Pages cut into blocks of at most `max` characters (a page longer than that is its own block). */
function pageBlocks(pages: Array<{ pageNumber: number; text: string }>, max: number): Array<Array<{ pageNumber: number; text: string }>> {
  const out: Array<Array<{ pageNumber: number; text: string }>> = [];
  let cur: Array<{ pageNumber: number; text: string }> = [];
  let chars = 0;
  for (const p of pages) {
    if (cur.length && chars + p.text.length > max) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(p);
    chars += p.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

function makePart(key: string, segmentId: string | null, label: string | null, pages: Array<{ pageNumber: number; text: string }>): CheckPart {
  const text = pages.map((p) => `${p.pageNumber}\u0001${p.text}`).join('\u0002');
  return { key, segmentId, label, pages, chars: pages.reduce((n, p) => n + p.text.length, 0), hash: sha256(text) };
}

/** Every part of a document that can be read for contradictions, with the text Claude is given. */
export function eligibleParts(documentId: string): CheckPart[] {
  const segs = listSegments(documentId);
  const out: CheckPart[] = [];
  if (segs.length) {
    for (const s of segs) {
      if (s.status !== 'done' && s.status !== 'parsed') continue;
      if (s.skipReason || s.duplicateOfSegmentId || SKIPPED_KINDS.has(s.kind)) continue;
      if (s.sourceTier === 'patient') continue;
      const detail = parseSegmentDetail(s.detailJson);
      if (routeOf({ kind: s.kind, detail }) === 'skip') continue;
      const pages = segmentPageTexts(documentId, s).map((p) => ({ pageNumber: p.pageNumber, text: p.text })).filter((p) => p.text.trim());
      if (!pages.length) continue;
      const blocks = pageBlocks(pages, SELF_CHECK_CALL_CHARS);
      blocks.forEach((b, i) => out.push(makePart(blocks.length > 1 ? `${s.id}#${i + 1}` : s.id, s.id, partLabel(s), b)));
    }
    return out;
  }
  // A document read before parts existed: blocks of its pages.
  const pages = db()
    .select({ pageNumber: schema.documentPages.pageNumber, text: schema.documentPages.text })
    .from(schema.documentPages)
    .where(eq(schema.documentPages.documentId, documentId))
    .orderBy(schema.documentPages.pageNumber)
    .all()
    .filter((p) => p.text.trim());
  for (const b of pageBlocks(pages, SELF_CHECK_CALL_CHARS)) out.push(makePart(`pages:${b[0].pageNumber}-${b[b.length - 1].pageNumber}`, null, null, b));
  return out;
}

/** A part still to read: never read at this version, its text changed, or its last reading failed. */
export function partIsDue(p: Pick<CheckPart, 'key' | 'hash'>, records: Record<string, SelfCheckPartRecord> | undefined): boolean {
  const r = records?.[p.key];
  return !r || r.version !== SELF_CHECK_VERSION || r.hash !== p.hash || r.status !== 'done';
}

/** Consecutive parts share a call up to SELF_CHECK_CALL_CHARS characters and SELF_CHECK_PARTS_PER_CALL parts. */
export function packCalls(parts: readonly CheckPart[]): CheckCall[] {
  const calls: CheckCall[] = [];
  let cur: CheckPart[] = [];
  let chars = 0;
  for (const p of parts) {
    if (cur.length && (chars + p.chars > SELF_CHECK_CALL_CHARS || cur.length >= SELF_CHECK_PARTS_PER_CALL)) {
      calls.push({ parts: cur, chars });
      cur = [];
      chars = 0;
    }
    cur.push(p);
    chars += p.chars;
  }
  if (cur.length) calls.push({ parts: cur, chars });
  return calls;
}

/** Dollars for `calls` calls holding `characters` characters of page text, at the model's price. */
export function estimateUsdFor(characters: number, calls: number, model: string): number {
  if (!calls) return 0;
  const price = MODEL_PRICES[model] ?? MODEL_PRICES['claude-sonnet-5-5'];
  const input = characters / TOKEN_CHARS + SELF_CHECK_CALL_OVERHEAD_TOKENS * calls;
  const output = SELF_CHECK_OUTPUT_TOKENS * calls;
  return Math.round(((input * price.input + output * price.output) / 1_000_000) * 10000) / 10000;
}

/** Sonnet 5.5 (the lead's choice for this check): small calls, a predictable price, whatever the reading model is. */
export const SELF_CHECK_MODEL = 'claude-sonnet-5-5';

function selfCheckModel(): string {
  return SELF_CHECK_MODEL;
}

/** What reading the document for contradictions would read now (every eligible part with `force`, else the due ones). */
export function planContradictionCheck(documentId: string, opts: { force?: boolean } = {}): ContradictionPlan {
  const parts = eligibleParts(documentId);
  const records = readSelfCheck(documentId)?.contradictions?.parts;
  const due = opts.force ? parts : parts.filter((p) => partIsDue(p, records));
  const calls = packCalls(due);
  const characters = due.reduce((n, p) => n + p.chars, 0);
  const model = selfCheckModel();
  return { eligible: parts.length, parts: due, calls, characters, estimateUsd: estimateUsdFor(characters, calls.length, model), model };
}

// ---------------------------------------------------------------------------
// 2. Contradictions: what Claude returned, checked
// ---------------------------------------------------------------------------

export interface CheckedSide {
  page: number;
  quote: string;
  norm: string;
  verified: boolean;
  /** Found in the stored page text (offsets), or only in the reading-order text. */
  inStored: boolean;
  matchKind: string;
  factId: string | null;
}

export interface CheckedContradiction {
  part: CheckPart;
  kind: ContradictionKind;
  what: string;
  first: CheckedSide;
  second: CheckedSide;
}

export interface MappedContradictions {
  kept: CheckedContradiction[];
  /** Returned but not kept: an unknown part, an empty or repeated passage, or two passages in two different parts. */
  setAside: number;
}

type FormsLookup = ReturnType<typeof pageTextFormsLookup>;

/** Where a passage is printed: its stated page first, then the part's other pages, then the call's (to see a crossing). */
function locateSide(forms: FormsLookup, part: CheckPart, callPages: readonly number[], stated: number, quote: string): { page: number; verified: boolean; inStored: boolean; matchKind: string } | null {
  const own = part.pages.map((p) => p.pageNumber);
  const order = [stated, ...own.filter((n) => n !== stated).sort((a, b) => Math.abs(a - stated) - Math.abs(b - stated)), ...callPages.filter((n) => !own.includes(n) && n !== stated)];
  for (const n of order) {
    const f = forms(n);
    if (!f) continue;
    const m = locateQuote(f.stored, quote);
    if (m && isVerifiedMatch(m)) return { page: n, verified: true, inStored: true, matchKind: storedMatchKind(m) };
    if (f.visual) {
      const v = locateQuote(f.visual, quote);
      if (v && isVerifiedMatch(v)) return { page: n, verified: true, inStored: false, matchKind: storedMatchKind(v) };
    }
  }
  return null;
}

/** The passage is in the text Claude was given for this part (its own lines, on every page it has). */
function inText(part: CheckPart, quote: string): boolean {
  return part.pages.some((p) => isVerifiedMatch(locateQuote(p.text, quote)));
}

/** The live detail of this document whose citation on that page holds the passage (so a finding citing it is matched). */
function factForSide(documentId: string, page: number, norm: string): string | null {
  const rows = db().all<{ factId: string; quote: string }>(sql`
    select c.fact_id as factId, c.quote as quote from citations c join facts f on f.id = c.fact_id
    where c.document_id = ${documentId} and c.page_number = ${page} and f.deleted_at is null and f.status not in ('superseded', 'disputed')`);
  for (const r of rows) if (passagesOverlap(normalizeText(r.quote), norm)) return r.factId;
  return null;
}

/** Wording Claude must not use in its own voice: who is right, a mistake, an error, a diagnosis. */
const JUDGING = /\b(?:is|was|seems|appears|looks)\s+(?:the\s+)?(?:correct|right|wrong|incorrect|accurate|inaccurate|mistaken|an?\s+(?:error|mistake|typo))\b|\b(?:likely|probably|possibly)\s+(?:a\s+)?(?:typo|error|mistake|wrong|correct)\b|\bshould\s+(?:be|read|say|have\s+been)\b|\b(?:typo|clerical error|documentation error|charting error)\b/i;

/** The model's sentence when it only says what the passages say; else the kind's own words. */
export function neutralWhat(what: string, kind: ContradictionKind): string {
  const t = clip(what, 300);
  if (!t || JUDGING.test(t) || looksLikeDiagnosis(t)) return `${contradictionKindWords(kind)}.`;
  return t;
}

/** Check what Claude returned for one call: parts known, passages found on their part's pages, two different passages. */
export function mapContradictions(documentId: string, call: CheckCall, ids: ReadonlyMap<string, CheckPart>, output: SelfCheckOutput, forms: FormsLookup): MappedContradictions {
  const out: MappedContradictions = { kept: [], setAside: 0 };
  const callPages = [...new Set(call.parts.flatMap((p) => p.pages.map((pg) => pg.pageNumber)))];
  for (const c of output.contradictions as SelfCheckAiContradiction[]) {
    const part = ids.get(c.part.trim());
    const qa = (c.first.quote ?? '').trim();
    const qb = (c.second.quote ?? '').trim();
    const na = normalizeText(qa);
    const nb = normalizeText(qb);
    if (!part || !na || !nb || na === nb) {
      out.setAside++;
      continue;
    }
    const own = new Set(part.pages.map((p) => p.pageNumber));
    const side = (stated: number, quote: string, norm: string): CheckedSide | 'crossed' => {
      // A page two notes share (an export prints the end of one and the start of the next on it): the passage must be
      // in this part's own text, not only somewhere on the page; one only in another part's text crosses two notes.
      if (!inText(part, quote) && call.parts.some((o) => o !== part && inText(o, quote))) return 'crossed';
      const at = locateSide(forms, part, callPages, Number.isFinite(stated) ? Math.trunc(stated) : part.pages[0].pageNumber, quote);
      if (at && !own.has(at.page)) return 'crossed';
      // Not found word for word: kept and flagged, on its stated page when that is the part's, else the part's first.
      const page = at?.page ?? (own.has(Math.trunc(stated)) ? Math.trunc(stated) : part.pages[0].pageNumber);
      return { page, quote: clip(quote, 400), norm, verified: Boolean(at?.verified), inStored: Boolean(at?.inStored), matchKind: at?.matchKind ?? 'none', factId: factForSide(documentId, page, norm) };
    };
    const a = side(c.first.page, qa, na);
    const b = side(c.second.page, qb, nb);
    if (a === 'crossed' || b === 'crossed') {
      out.setAside++;
      continue;
    }
    out.kept.push({ part, kind: c.kind, what: neutralWhat(c.what, c.kind), first: a, second: b });
  }
  return out;
}

interface ContradictionOnFile {
  findingId: string;
  own: boolean;
  sides: Array<{ factId: string | null; page: number | null; norm: string | null }>;
}

/** Live findings with evidence on this document, grouped (for the duplicate test). */
function findingsOnDocument(documentId: string): ContradictionOnFile[] {
  const by = new Map<string, ContradictionOnFile>();
  for (const e of evidenceOnDocument(documentId)) {
    let f = by.get(e.findingId);
    if (!f) {
      f = { findingId: e.findingId, own: e.ruleId === CONTRADICTION_RULE, sides: [] };
      by.set(e.findingId, f);
    }
    f.sides.push({ factId: e.factId, page: e.citation && e.citation.documentId === documentId ? e.citation.pageNumber : null, norm: e.citation && e.citation.documentId === documentId ? e.citation.norm : null });
  }
  return [...by.values()];
}

function sideCovered(s: CheckedSide, f: ContradictionOnFile): boolean {
  return f.sides.some((e) => (s.factId != null && e.factId === s.factId) || (e.page != null && e.norm != null && Math.abs(e.page - s.page) <= 1 && passagesOverlap(e.norm, s.norm)));
}

/** The finding already on file that holds both passages: this check's own (a repeat) or another (already raised). */
export function coveringFinding(c: Pick<CheckedContradiction, 'first' | 'second'>, onFile: readonly ContradictionOnFile[]): ContradictionOnFile | null {
  return onFile.find((f) => sideCovered(c.first, f) && sideCovered(c.second, f)) ?? null;
}

function sideNote(s: CheckedSide): string {
  return `Says "${clip(s.quote, 300)}" (page ${s.page})${s.verified ? '' : '; not found word for word on the page'}`;
}

/** One finding per contradiction: both passages with their pages, the kind, the institution; never who is right. */
export function contradictionDraft(doc: Pick<DocRow, 'id' | 'title' | 'institutionId' | 'metadataJson'>, c: CheckedContradiction): FindingDraft {
  const pair = [c.first.norm.slice(0, 160), c.second.norm.slice(0, 160)].sort();
  const unverified = !c.first.verified || !c.second.verified;
  const sides = [c.first, c.second].sort((x, y) => x.page - y.page);
  return {
    ruleId: CONTRADICTION_RULE,
    category: CONTRADICTION_CATEGORY,
    severity: unverified ? 'low' : c.kind === 'other' ? 'low' : 'medium',
    title: clip(`${lead(doc)}: ${c.what.replace(/\.$/, '')}`, 140),
    whyItMatters:
      'One document says two things that cannot both be true. Both passages are quoted with their pages. Claude does not say which is right: the people who wrote it can, and can correct their record. Nothing was changed.',
    detail: [
      `${contradictionKindWords(c.kind)}, in "${clip(doc.title, 120)}"${c.part.label ? ` (${c.part.label})` : ''}:`,
      ...sides.map((s) => `"${clip(s.quote, 300)}" (page ${s.page})${s.verified ? '' : ' - not found word for word on the page'}`),
    ].join('\n'),
    evidence: sides.map((s) => ({ factId: s.factId, documentId: doc.id, note: sideNote(s), pendingCitation: { documentId: doc.id, pageNumber: s.page, quote: s.quote } })),
    key: [doc.id, c.kind, ...pair],
  };
}

/** A passage found only in the page's reading-order text is verified there too (findings.ts checks the stored text only). */
function markVisualCitations(findingId: string, documentId: string, sides: readonly CheckedSide[]): void {
  for (const s of sides) {
    if (!s.verified || s.inStored) continue;
    db().update(schema.citations)
      .set({ verified: true, matchKind: s.matchKind, pageNumber: s.page, charStart: null, charEnd: null })
      .where(and(eq(schema.citations.findingId, findingId), eq(schema.citations.documentId, documentId), eq(schema.citations.quote, s.quote), eq(schema.citations.verified, false)))
      .run();
  }
}

// ---------------------------------------------------------------------------
// 2. Contradictions: the job
// ---------------------------------------------------------------------------

export interface SelfCheckPayload {
  documentId: string;
  /** upload: a new upload (automatic); user: the user asked (one document or many). */
  reason: 'upload' | 'user';
  /** Read every part again (Check again), not only the due ones. */
  force?: boolean;
  /** The user said yes to this cost (above the limit, or his own request). */
  approved?: boolean;
  /** The cost he said yes to (approvalCovers); absent on a job queued before 2026-10-09's review: any cost. */
  approvedUsd?: number;
  batchId?: string;
}

export interface SelfCheckJobResult {
  documentId: string;
  calls: number;
  found: number;
  raised: number;
  alreadyRaised: number;
  setAside: number;
  unverified: number;
  failedParts: number;
  runId: string | null;
  state: string;
}

function documentTypeWords(category: string): string | null {
  return category && category !== 'other' ? category.replace(/_/g, ' ') : null;
}

/** The `self_check` job: the flags again (no AI), then the parts due, one small call at a time. */
export async function selfCheckJob(ctx: JobContext<SelfCheckPayload>): Promise<SelfCheckJobResult> {
  const p = ctx.payload;
  const documentId = p.documentId;
  if (!documentId) throw new Error('self_check: documentId missing');
  const doc = liveDocumentRow(documentId);
  if (!doc) throw new JobCancelledError("the document was deleted, or is held back as someone else's record");
  const owned = () => !ctx.stillOwned || ctx.stillOwned();
  const result: SelfCheckJobResult = { documentId, calls: 0, found: 0, raised: 0, alreadyRaised: 0, setAside: 0, unverified: 0, failedParts: 0, runId: null, state: 'done' };
  ctx.setProgress(0.02, `${clip(doc.title, 60)}: checking the lab flags`);
  try {
    runFlagCheck(documentId, { trigger: p.reason });
  } catch (err) {
    console.warn(`[self-check] flags of ${documentId}: ${messageOf(err)}`);
  }

  // An automatic check of a new upload that is no longer a clinical record (sorted, or marked by hand, as a summary or
  // The patient's own notes since): its flags were checked again above; Claude does not read it (review 2026-10-09).
  if (!p.approved && !checksByItself(doc, readSelfCheck(documentId))) {
    patchContradictions(documentId, { state: 'none', jobId: null });
    ctx.setProgress(1, 'not a clinical record now: not read for contradictions by itself');
    result.state = 'none';
    return result;
  }
  const plan = planContradictionCheck(documentId, { force: p.force });
  if (!plan.calls.length) {
    patchContradictions(documentId, { state: 'done', jobId: null, decision: null, approvedUsd: null, error: null });
    ctx.setProgress(1, 'nothing left to read for contradictions');
    return result;
  }
  if (!aiReady()) {
    patchContradictions(documentId, { state: 'off', jobId: null });
    ctx.setProgress(1, 'Claude is off or has no key');
    result.state = 'off';
    return result;
  }
  // Any check not approved at this cost asks first when its parts grew past the limit since it was queued: an automatic
  // one (a new upload, or a document the user once asked for, read again), or a yes given to a much smaller cost.
  const covered = Boolean(p.approved) && (p.approvedUsd == null || approvalCovers(p.approvedUsd, plan.estimateUsd));
  if (!covered && !underCeiling(plan.estimateUsd)) {
    patchContradictions(documentId, { state: 'ask', jobId: null, estimateUsd: plan.estimateUsd, calls: plan.calls.length, decision: null, approvedUsd: null });
    ctx.setProgress(1, 'above the limit: waiting for a yes');
    result.state = 'ask';
    return result;
  }
  patchContradictions(documentId, { state: 'running', jobId: ctx.job.id, estimateUsd: plan.estimateUsd, calls: plan.calls.length, error: null });

  const forms = pageTextFormsLookup(documentId);
  const onFile = findingsOnDocument(documentId);
  const aiCallIds: string[] = [];
  const run = createRun({ rulesOnly: false, scope: runScopeFor(p.reason, documentId) });
  // The run names the model these calls use (createRun names the reading model).
  db().update(schema.crossrefRuns).set({ model: plan.model }).where(eq(schema.crossrefRuns.id, run.id)).run();
  result.runId = run.id;
  const counts = { found: 0, raised: 0, alreadyRaised: 0, setAside: 0, unverified: 0 };
  let failures = 0;
  let successes = 0;
  let stopped = false;
  let fatal: Error | null = null;
  const model = plan.model;
  const short = clip(doc.title, 60);
  /** Parts this job read (or tried), by key and text: a part due later in the job (a reading ended meanwhile) is read in a further round. */
  const attempted = new Set<string>();
  const queue = [...plan.calls];
  let total = queue.length;
  let i = 0;

  for (let round = 0; round < 3 && !stopped && !fatal; round++) {
    while (queue.length) {
      if (ctx.signal.aborted) {
        stopped = true;
        break;
      }
      const call = queue.shift()!;
      for (const pt of call.parts) attempted.add(`${pt.key}|${pt.hash}`);
      const ids = new Map<string, CheckPart>(call.parts.map((pt, j) => [`p${j + 1}`, pt]));
      const first = call.parts[0].pages[0].pageNumber;
      const lastPart = call.parts[call.parts.length - 1];
      const last = lastPart.pages[lastPart.pages.length - 1].pageNumber;
      ctx.setProgress(0.05 + (0.9 * i) / Math.max(1, total), `${short}: reading pages ${first}-${last} for contradictions (${i + 1} of ${total})`);
      i++;
      let data: SelfCheckOutput;
      try {
        const res = await callStructured({
          purpose: 'self_check',
          model,
          system: SELF_CHECK_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildSelfCheckUserMessage({ documentTitle: doc.title, documentType: documentTypeWords(doc.category), parts: [...ids].map(([id, pt]) => ({ id, label: pt.label, pages: pt.pages })) }) }],
          schema: selfCheckOutput,
          documentIds: [documentId],
          jobId: ctx.job.id,
          maxTokens: 16_000,
          effort: SELF_CHECK_EFFORT,
          requestSummary: `check against itself p.${first}-${last}`,
          signal: ctx.signal,
        });
        aiCallIds.push(res.callId);
        data = res.data;
      } catch (err) {
        if (ctx.signal.aborted) {
          stopped = true;
          break;
        }
        failures++;
        const msg = clip(messageOf(err), 300);
        if (owned()) {
          patchSelfCheck(documentId, (prev) => {
            const c = prev.contradictions ?? emptyContradictions();
            const parts = { ...c.parts };
            for (const pt of call.parts) parts[pt.key] = { version: SELF_CHECK_VERSION, hash: pt.hash, at: nowIso(), found: 0, status: 'failed', error: msg };
            return { ...prev, contradictions: { ...c, parts, at: nowIso() } };
          });
        }
        if (err instanceof AiDisabledError || err instanceof NoApiKeyError) {
          fatal = err;
          break;
        }
        continue;
      }
      if (!owned()) {
        stopped = true;
        break;
      }
      successes++;
      const mapped = mapContradictions(documentId, call, ids, data, forms);
      counts.found += data.contradictions.length;
      counts.setAside += mapped.setAside;
      const drafts: Array<{ draft: FindingDraft; c: CheckedContradiction }> = [];
      const foundByPart = new Map<string, number>();
      for (const c of mapped.kept) {
        foundByPart.set(c.part.key, (foundByPart.get(c.part.key) ?? 0) + 1);
        if (!c.first.verified || !c.second.verified) counts.unverified++;
        const cover = coveringFinding(c, onFile);
        if (cover) {
          if (!cover.own) counts.alreadyRaised++;
          continue;
        }
        drafts.push({ draft: contradictionDraft(doc, c), c });
        // A later call naming the same two passages is the same contradiction.
        onFile.push({ findingId: `pending:${drafts.length}`, own: true, sides: [c.first, c.second].map((s) => ({ factId: s.factId, page: s.page, norm: s.norm })) });
      }
      if (drafts.length) {
        // Written as rule drafts (matched by fingerprint and by the evidence test above, never by findings.ts's title
        // likeness, which would fold two contradictions of one document into one), then marked as Claude's: origin ai.
        const applied = applyDrafts(run.id, 'rule', drafts.map((x) => x.draft));
        counts.raised += applied.created;
        if (applied.findingIds.length) db().update(schema.findings).set({ origin: 'ai' }).where(and(inArray(schema.findings.id, applied.findingIds), eq(schema.findings.ruleId, CONTRADICTION_RULE))).run();
        for (const x of drafts) {
          const fid = findingIdOf(x.draft);
          if (fid) markVisualCitations(fid, documentId, [x.c.first, x.c.second]);
        }
      }
      patchSelfCheck(documentId, (prev) => {
        const c = prev.contradictions ?? emptyContradictions();
        const parts = { ...c.parts };
        for (const pt of call.parts) parts[pt.key] = { version: SELF_CHECK_VERSION, hash: pt.hash, at: nowIso(), found: foundByPart.get(pt.key) ?? 0, status: 'done', error: null };
        return { ...prev, contradictions: { ...c, parts, at: nowIso() } };
      });
    }
    if (stopped || fatal || !owned()) break;
    // Parts that became due while this job ran (another reading pass ended): read them too, under the limit.
    const more = planContradictionCheck(documentId).parts.filter((pt) => !attempted.has(`${pt.key}|${pt.hash}`));
    if (!more.length) break;
    const calls = packCalls(more);
    const usd = estimateUsdFor(more.reduce((n, pt) => n + pt.chars, 0), calls.length, model);
    if (!underCeiling(usd)) break;
    queue.push(...calls);
    total += calls.length;
  }

  result.calls = aiCallIds.length;
  Object.assign(result, counts);
  result.failedParts = failures;
  if (!owned()) return { ...result, state: 'interrupted' };
  const aiStats = { returned: counts.found, kept: counts.raised, droppedNoEvidence: counts.setAside, droppedWording: 0, droppedIds: 0 };
  const allFailed = successes === 0 && failures > 0;
  finishRun(run.id, { status: allFailed ? 'failed' : 'done', error: allFailed ? 'Every call failed' : null, aiCallIds, aiStats });
  const state = fatal ? 'off' : stopped ? 'stopped' : allFailed ? 'failed' : 'done';
  result.state = state;
  patchSelfCheck(documentId, (prev) => {
    const c = prev.contradictions ?? emptyContradictions();
    return {
      ...prev,
      contradictions: {
        ...c,
        version: SELF_CHECK_VERSION,
        state,
        at: nowIso(),
        found: c.found + counts.found,
        raised: c.raised + counts.raised,
        alreadyRaised: c.alreadyRaised + counts.alreadyRaised,
        setAside: c.setAside + counts.setAside,
        unverified: c.unverified + counts.unverified,
        jobId: null,
        decision: null,
        approvedUsd: null,
        error: allFailed ? 'every call failed; Check it against itself tries again' : failures ? `${plural(failures, 'call')} failed; Check it against itself reads those parts again` : null,
      },
    };
  });
  ctx.setProgress(1, `${counts.raised} new, ${counts.alreadyRaised} already on file`);
  if (allFailed && !fatal) throw new Error('the check against itself failed: every call failed');
  return result;
}

// ---------------------------------------------------------------------------
// When: after a reading pass, the user's request, his answer to the question
// ---------------------------------------------------------------------------

export interface QueueResult {
  documentId: string;
  /** queued: a job will read it; asked: above the limit, waiting for a yes; nothing: no part to read; off: Claude off or no key; declined: "Not now" kept. */
  outcome: 'queued' | 'asked' | 'nothing' | 'off' | 'declined';
  jobId: string | null;
  estimateUsd: number;
  calls: number;
}

function queueJob(documentId: string, payload: SelfCheckPayload): string {
  const job = enqueueJob({ type: 'self_check', payload: payload as unknown as Record<string, unknown>, documentId, dedupe: true });
  // A request made while an automatic check waits its turn: the waiting job takes the request's terms.
  if (job.status === 'queued' && (payload.force || payload.approved || payload.reason === 'user')) {
    const prev = parseJson<Partial<SelfCheckPayload>>(job.payloadJson, {});
    const approved = Boolean(prev.approved || payload.approved);
    // The larger of the two costs said yes to (approvalCovers); none when neither was a yes.
    const approvedUsd = approved ? Math.max(prev.approved ? (prev.approvedUsd ?? 0) : 0, payload.approved ? (payload.approvedUsd ?? 0) : 0) : undefined;
    const next = { ...prev, ...payload, force: Boolean(prev.force || payload.force), approved, approvedUsd };
    db().update(schema.jobs).set({ payloadJson: JSON.stringify(next) }).where(eq(schema.jobs.id, job.id)).run();
  }
  return job.id;
}

/** Where a queued check stands: its job running now, or waiting its turn (a request while it runs joins it). */
function stateOfJob(jobId: string): 'queued' | 'running' {
  return db().select({ status: schema.jobs.status }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).get()?.status === 'running' ? 'running' : 'queued';
}

/** Jobs that are waiting or running. */
function activeJob(jobId: string | null | undefined): boolean {
  if (!jobId) return false;
  const s = db().select({ status: schema.jobs.status }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).get()?.status;
  return s === 'queued' || s === 'running';
}

/**
 * At the end of every reading pass (ai/extraction.ts). A new upload, or a document already checked: the flags again (no
 * AI), then its parts still to read for contradictions, by a job under the per-document limit (above it, ask once).
 * Any other document: nothing (existing documents only when the user asks). Never throws.
 */
export function afterReadingPass(documentId: string, info: { outcome: string; reason?: string | null } = { outcome: 'done' }): QueueResult | null {
  try {
    if (info.outcome === 'cancelled' || info.outcome === 'failed') return null;
    const doc = liveDocumentRow(documentId);
    if (!doc) return null;
    const rec = readSelfCheck(documentId);
    if (!rec && !isNewUpload(doc, selfCheckSince())) return null;
    const trigger = rec?.trigger ?? 'upload';
    runFlagCheck(documentId, { trigger });
    // Sorted or marked since as a summary, a letter or the patient's own notes: its flags (now its claims) were checked again
    // above, which clears what no longer holds; Claude does not read it by itself (review 2026-10-09).
    if (!checksByItself(doc, rec)) return { documentId, jobId: null, estimateUsd: 0, calls: 0, outcome: 'nothing' };
    const plan = planContradictionCheck(documentId);
    const base = { documentId, jobId: null, estimateUsd: plan.estimateUsd, calls: plan.calls.length };
    if (!plan.calls.length) {
      patchSelfCheck(documentId, (prev) => ({ ...prev, contradictions: { ...(prev.contradictions ?? emptyContradictions()), state: prev.contradictions?.state === 'running' || prev.contradictions?.state === 'queued' ? prev.contradictions.state : 'done', at: nowIso() } }));
      return { ...base, outcome: 'nothing' };
    }
    if (!aiReady()) {
      patchContradictions(documentId, { state: 'off', estimateUsd: plan.estimateUsd, calls: plan.calls.length });
      return { ...base, outcome: 'off' };
    }
    const c = rec?.contradictions;
    if (c?.decision === 'not_now') {
      patchContradictions(documentId, { state: 'declined', estimateUsd: plan.estimateUsd, calls: plan.calls.length });
      return { ...base, outcome: 'declined' };
    }
    // A yes waiting for its job covers the cost it was given to (and a quarter more), never any cost.
    const yes = c?.decision === 'yes' && approvalCovers(c.approvedUsd, plan.estimateUsd);
    if (!underCeiling(plan.estimateUsd) && !yes) {
      patchContradictions(documentId, { state: 'ask', estimateUsd: plan.estimateUsd, calls: plan.calls.length, decision: null, approvedUsd: null });
      return { ...base, outcome: 'asked' };
    }
    const jobId = queueJob(documentId, { documentId, reason: trigger, approved: yes, ...(yes && c?.approvedUsd != null ? { approvedUsd: c.approvedUsd } : {}) });
    patchContradictions(documentId, { state: stateOfJob(jobId), jobId, estimateUsd: plan.estimateUsd, calls: plan.calls.length });
    return { ...base, jobId, outcome: 'queued' };
  } catch (err) {
    console.warn(`[self-check] after the reading of ${documentId}: ${messageOf(err)}`);
    return null;
  }
}

export interface DocumentEstimate {
  documentId: string;
  title: string;
  /** Checked before at this version (Check again reads every part once more). */
  checked: boolean;
  /** Parts that can be read, parts to read now, calls, dollars. */
  eligible: number;
  parts: number;
  calls: number;
  estimateUsd: number;
  /** Values with a printed flag the app can compare (free). */
  flagsToCheck: number;
  /** Why nothing would be read ("not read yet", "held back"...), or null. */
  blocked: string | null;
}

/** The estimate for one document, before anything is sent. */
export function estimateDocument(documentId: string, opts: { force?: boolean; readings?: readonly LabReadingRecord[] } = {}): DocumentEstimate {
  const doc = liveDocumentRow(documentId);
  if (!doc) throw notFound('document not found');
  const rec = readSelfCheck(documentId);
  const plan = planContradictionCheck(documentId, opts);
  const notRead = doc.extractionStatus === 'none' || doc.extractionStatus === 'queued' || doc.extractionStatus === 'running';
  const blocked = plan.eligible === 0 ? (notRead ? 'Claude has not read it yet' : 'nothing in it to read for contradictions') : null;
  return {
    documentId,
    title: doc.title,
    checked: Boolean(rec?.contradictions && rec.contradictions.version === SELF_CHECK_VERSION && rec.contradictions.state === 'done'),
    eligible: plan.eligible,
    parts: plan.parts.length,
    calls: plan.calls.length,
    estimateUsd: plan.estimateUsd,
    flagsToCheck: flagRowsOf(documentId, opts.readings).checked,
    blocked,
  };
}

export function estimateMany(ids: readonly string[], opts: { force?: boolean } = {}): { items: DocumentEstimate[]; missing: string[]; totalUsd: number; calls: number } {
  const items: DocumentEstimate[] = [];
  const missing: string[] = [];
  let readings: LabReadingRecord[] | undefined;
  for (const id of [...new Set(ids)]) {
    if (!liveDocumentRow(id)) {
      missing.push(id);
      continue;
    }
    items.push(estimateDocument(id, { force: opts.force, readings: (readings ??= loadLabReadings()) }));
  }
  return { items, missing, totalUsd: Math.round(items.reduce((n, x) => n + x.estimateUsd, 0) * 10000) / 10000, calls: items.reduce((n, x) => n + x.calls, 0) };
}

/** The user's "Check it against itself" (one document): the flags now, then a job for the contradictions at the cost shown. */
export function requestSelfCheck(documentId: string, opts: { force?: boolean; batchId?: string } = {}): QueueResult & { flags: { checked: number; mismatched: number; findingId: string | null } } {
  const doc = liveDocumentRow(documentId);
  if (!doc) throw notFound('document not found');
  patchSelfCheck(documentId, (prev) => ({ ...prev, trigger: prev.trigger ?? 'user', ...(prev.contradictions ? { contradictions: { ...prev.contradictions, decision: null, approvedUsd: null } } : {}) }));
  const flags = runFlagCheck(documentId, { trigger: 'user' });
  const flagOut = { checked: flags.checked, mismatched: flags.rows.length + flags.alreadyRaised, findingId: flags.findingId };
  const plan = planContradictionCheck(documentId, { force: opts.force });
  const base = { documentId, jobId: null, estimateUsd: plan.estimateUsd, calls: plan.calls.length, flags: flagOut };
  if (!plan.calls.length) {
    if (plan.eligible) patchContradictions(documentId, { state: 'done' });
    return { ...base, outcome: 'nothing' };
  }
  if (!aiReady()) {
    patchContradictions(documentId, { state: 'off', estimateUsd: plan.estimateUsd, calls: plan.calls.length });
    return { ...base, outcome: 'off' };
  }
  const jobId = queueJob(documentId, { documentId, reason: 'user', force: opts.force, approved: true, approvedUsd: plan.estimateUsd, batchId: opts.batchId });
  patchContradictions(documentId, { state: stateOfJob(jobId), jobId, estimateUsd: plan.estimateUsd, calls: plan.calls.length, decision: null, approvedUsd: null });
  return { ...base, jobId, outcome: 'queued' };
}

/** Many documents at once (from Documents): each as above, one batch. */
export function requestMany(ids: readonly string[], opts: { force?: boolean } = {}): { batchId: string; items: Array<ReturnType<typeof requestSelfCheck>>; missing: string[] } {
  const batchId = newId();
  const items: Array<ReturnType<typeof requestSelfCheck>> = [];
  const missing: string[] = [];
  for (const id of [...new Set(ids)]) {
    if (!liveDocumentRow(id)) {
      missing.push(id);
      continue;
    }
    items.push(requestSelfCheck(id, { force: opts.force, batchId }));
  }
  return { batchId, items, missing };
}

/** The user's answer to the question asked above the limit: yes reads at the cost shown; not now is kept. */
export function answerSelfCheck(documentId: string, answer: 'yes' | 'not_now'): QueueResult {
  const doc = liveDocumentRow(documentId);
  if (!doc) throw notFound('document not found');
  const now = nowIso();
  if (answer === 'not_now') {
    patchContradictions(documentId, { state: 'declined', decision: 'not_now', decidedAt: now, approvedUsd: null });
    return { documentId, outcome: 'declined', jobId: null, estimateUsd: readSelfCheck(documentId)?.contradictions?.estimateUsd ?? 0, calls: 0 };
  }
  const plan = planContradictionCheck(documentId);
  if (!plan.calls.length) {
    patchContradictions(documentId, { state: 'done', decision: null, decidedAt: now });
    return { documentId, outcome: 'nothing', jobId: null, estimateUsd: 0, calls: 0 };
  }
  if (!aiReady()) {
    patchContradictions(documentId, { state: 'off', decision: 'yes', decidedAt: now });
    return { documentId, outcome: 'off', jobId: null, estimateUsd: plan.estimateUsd, calls: plan.calls.length };
  }
  const trigger = readSelfCheck(documentId)?.trigger ?? 'upload';
  const jobId = queueJob(documentId, { documentId, reason: trigger, approved: true, approvedUsd: plan.estimateUsd });
  patchContradictions(documentId, { state: stateOfJob(jobId), decision: 'yes', decidedAt: now, approvedUsd: plan.estimateUsd, jobId, estimateUsd: plan.estimateUsd, calls: plan.calls.length });
  return { documentId, outcome: 'queued', jobId, estimateUsd: plan.estimateUsd, calls: plan.calls.length };
}

// ---------------------------------------------------------------------------
// A document deleted, held back, restored, or given another tier (review 2026-10-09)
// ---------------------------------------------------------------------------

/** The line an open finding of this check is closed with when its document is deleted or held back. */
export const SELF_CHECK_GONE_NOTE = `${AUTO_CLEARED_PREFIX} its document was deleted, or held back as someone else's record.`;

function findingsOfDocument(documentId: string): Array<{ id: string; status: string; verdictNote: string | null }> {
  return db().all<{ id: string; status: string; verdictNote: string | null }>(sql`
    select distinct f.id as id, f.status as status, f.verdict_note as verdictNote
    from findings f join finding_evidence fe on fe.finding_id = f.id
    where fe.document_id = ${documentId} and f.deleted_at is null and f.rule_id in (${FLAG_MISMATCH_RULE}, ${CONTRADICTION_RULE})`);
}

/**
 * This check's findings follow their document. Deleted or held back ("May be someone else's record", "Not my
 * record"): each one nobody answered or wrote on is closed with SELF_CHECK_GONE_NOTE, so another person's lab flags or notes
 * never wait in What Claude noticed (the rules runs never touch these rules). Restored as the user's: exactly those come
 * back open. An answered finding is never touched. Returns how many changed.
 */
export function followDocument(documentId: string, event: 'deleted' | 'restored'): number {
  const now = nowIso();
  let n = 0;
  if (event === 'deleted') {
    for (const f of findingsOfDocument(documentId)) {
      if (f.status !== 'new' || isUserNote(f.verdictNote)) continue;
      db().update(schema.findings).set({ status: 'resolved', verdictNote: SELF_CHECK_GONE_NOTE, verdictAt: now, updatedAt: now }).where(eq(schema.findings.id, f.id)).run();
      n++;
    }
    return n;
  }
  if (!liveDocumentRow(documentId)) return 0; // restored but still held back (Not my record): stays closed
  for (const f of findingsOfDocument(documentId)) {
    if (f.status !== 'resolved' || f.verdictNote !== SELF_CHECK_GONE_NOTE) continue;
    db().update(schema.findings).set({ status: 'new', verdictNote: null, verdictAt: null, updatedAt: now }).where(eq(schema.findings.id, f.id)).run();
    n++;
  }
  return n;
}
onDocumentDeletedOrRestored((documentId, event) => {
  followDocument(documentId, event);
});

/**
 * A checked document given another tier (sorted after it was read, or by hand): its flags are checked again at once,
 * so a flag finding about values that are now a summary's or the user's own claims is cleared (never an answered one).
 */
onSourceTierChange((documentId) => {
  if (!readSelfCheck(documentId) || !liveDocumentRow(documentId)) return;
  runFlagCheck(documentId);
});

// ---------------------------------------------------------------------------
// Reading it back: one document, one facility, every facility
// ---------------------------------------------------------------------------

export interface SelfCheckFindingItem {
  id: string;
  title: string;
  category: string;
  status: string;
  severity: string;
  /** Flag rows listed (a flag finding), or 1 (a contradiction). */
  count: number;
}

export interface FacilityCounts {
  institutionId: string | null;
  name: string | null;
  /** Documents from there checked against themselves. */
  documents: number;
  /** Lab values whose flag doesn't match, and contradictions (answers "Incorrect" left out). */
  flags: number;
  contradictions: number;
  /** Of those findings, still without an answer. */
  open: number;
  words: string;
}

export interface DocumentSelfCheck {
  documentId: string;
  record: SelfCheckRecord | null;
  newUpload: boolean;
  facility: { id: string | null; name: string | null };
  counts: { flags: number; contradictions: number };
  findings: SelfCheckFindingItem[];
  words: string | null;
  facilityTotals: FacilityCounts | null;
}

/**
 * The findings of this check, live, by document (flag findings counted by their rows; "Incorrect" ones kept apart).
 * One the app closed by itself ("Cleared automatically: ...": the flags were put right, the document was deleted or held
 * back) no longer holds and is left out (review 2026-10-09); "Yes, done" from the user still counts.
 */
function selfCheckFindings(documentIds?: readonly string[]): Array<SelfCheckFindingItem & { documentId: string }> {
  const rows = db().all<{ id: string; title: string; category: string; status: string; severity: string; ruleId: string; documentId: string; n: number }>(sql`
    select f.id as id, f.title as title, f.category as category, f.status as status, f.severity as severity, f.rule_id as ruleId,
           fe.document_id as documentId, count(*) as n
    from findings f join finding_evidence fe on fe.finding_id = f.id
    where f.deleted_at is null and f.rule_id in (${FLAG_MISMATCH_RULE}, ${CONTRADICTION_RULE}) and fe.document_id is not null
      and not (f.status = 'resolved' and coalesce(f.verdict_note, '') like ${`${AUTO_CLEARED_PREFIX}%`})
    group by f.id, fe.document_id`);
  const wanted = documentIds ? new Set(documentIds) : null;
  return rows
    .filter((r) => !wanted || wanted.has(r.documentId))
    .map((r) => ({ id: r.id, title: r.title, category: r.category, status: r.status, severity: r.severity, documentId: r.documentId, count: r.ruleId === FLAG_MISMATCH_RULE ? r.n : 1 }));
}

function countOf(items: ReadonlyArray<SelfCheckFindingItem>): { flags: number; contradictions: number; open: number } {
  let flags = 0;
  let contradictions = 0;
  let open = 0;
  for (const f of items) {
    if (f.status === 'disputed') continue;
    if (f.category === FLAG_MISMATCH_CATEGORY) flags += f.count;
    else contradictions += 1;
    if (f.status === 'new') open++;
  }
  return { flags, contradictions, open };
}

/** The checked documents (a record on file), each with its facility. */
function checkedDocuments(): Array<{ id: string; facility: Facility }> {
  const rows = db().all<{ id: string; institutionId: string | null; metadataJson: string }>(sql`
    select id, institution_id as institutionId, metadata_json as metadataJson from documents
    where deleted_at is null and json_extract(metadata_json, '$.selfCheck') is not null`);
  if (!rows.length) return [];
  const index = placeIndex();
  return rows.map((r) => ({ id: r.id, facility: facilityOf(r, index) }));
}

/** One facility's key: its People and places row, else its name as written (normalised), else none. */
function facilityKey(f: Facility): string {
  return f.id ? `id:${f.id}` : f.name ? `name:${normalizeKey(f.name)}` : 'none';
}

/**
 * Counts per facility (every one, or the one People and places row `institutionId`). A document counts under its
 * facility (facilityOf): its link, else the place named when it was sorted or read; one with none counts under null.
 */
export function facilityCounts(institutionId?: string | null): FacilityCounts[] {
  const docs = checkedDocuments().filter((d) => institutionId === undefined || (institutionId === null ? !d.facility.id && !d.facility.name : d.facility.id === institutionId));
  if (!docs.length) return [];
  const byDoc = new Map<string, SelfCheckFindingItem[]>();
  for (const f of selfCheckFindings(docs.map((d) => d.id))) {
    const list = byDoc.get(f.documentId);
    if (list) list.push(f);
    else byDoc.set(f.documentId, [f]);
  }
  const groups = new Map<string, { facility: Facility; ids: string[] }>();
  for (const d of docs) {
    const k = facilityKey(d.facility);
    const g = groups.get(k);
    if (g) g.ids.push(d.id);
    else groups.set(k, { facility: d.facility, ids: [d.id] });
  }
  const out: FacilityCounts[] = [];
  for (const { facility, ids } of groups.values()) {
    const c = countOf(ids.flatMap((id) => byDoc.get(id) ?? []));
    out.push({ institutionId: facility.id, name: facility.name, documents: ids.length, ...c, words: `${facilityWords(facility.name)}: ${countsWords(c)} in ${plural(ids.length, 'document')} checked` });
  }
  // Most found first; then named places by name; a document with no place named last.
  return out.sort((a, b) => b.flags + b.contradictions - (a.flags + a.contradictions) || (a.name ? 0 : 1) - (b.name ? 0 : 1) || (a.name ?? '').localeCompare(b.name ?? ''));
}

/** One document: its record, its findings and counts, its facility's totals (the document's "How much was read" panel). */
export function documentSelfCheck(documentId: string): DocumentSelfCheck {
  const doc = liveDocumentRow(documentId);
  if (!doc) throw notFound('document not found');
  let record = readSelfCheck(documentId);
  // A check whose job is gone (cancelled from the jobs list, or lost) reads as stopped, never "next" for good.
  const c = record?.contradictions;
  if (record && c && (c.state === 'queued' || c.state === 'running') && !activeJob(c.jobId)) record = { ...record, contradictions: { ...c, state: 'stopped' } };
  const findings = selfCheckFindings([documentId]).map(({ documentId: _d, ...f }) => f);
  const counts = countOf(findings);
  const facility = facilityOf(doc);
  let facilityTotals: FacilityCounts | null = null;
  if (record && (facility.id || facility.name)) {
    const key = facilityKey(facility);
    facilityTotals = (facility.id ? facilityCounts(facility.id) : facilityCounts()).find((x) => facilityKey({ id: x.institutionId, name: x.name, source: null }) === key) ?? null;
  }
  const words = record ? `Checked against itself: ${countsWords(counts)}.` : null;
  return { documentId, record, newUpload: isNewUpload(doc), facility: { id: facility.id, name: facility.name }, counts: { flags: counts.flags, contradictions: counts.contradictions }, findings, words, facilityTotals };
}
