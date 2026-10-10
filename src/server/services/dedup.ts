/**
 * Dedup keys and merge proposals. A fact's `dedupKey` is its type plus the
 * normalised subject and the date at its precision (and, for a diagnosis or a
 * clinician statement, its certainty or stance); identical keys from
 * different documents are almost certainly the same fact. Inside one
 * extraction an equal key alone is not enough: `sameFact` also compares the
 * meaning-bearing attributes, dates and statements. The `subjectKey`
 * is the type plus the subject only, used for grouping (lab trends, the
 * supersede picker) and for the looser "same subject, similar statement"
 * proposal. Nothing merges here: proposals land in `fact_merges` as pending.
 */
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { db, schema } from '../db';
import { newId, normalizeKey, nowIso, parseJson } from '../util/ids';
import { datesAgree, parsePartialDate } from '../../shared/dates';
import { labDedupValueKey, labValueIdentity, parseLabValue } from '../../shared/labvalues';
import { textSimilarity } from '../ai/citations';

export const STATEMENT_SIMILARITY_THRESHOLD = 0.6;

export interface KeyableFact {
  type: string;
  attributes: Record<string, unknown> | null | undefined;
  /** ISO partial date (or free text) of the fact itself. */
  date?: string | null;
}

function str(a: Record<string, unknown> | null | undefined, key: string): string {
  const v = a?.[key];
  if (v == null) return '';
  return typeof v === 'string' ? v : String(v);
}

function dateKey(text: string | null | undefined): string {
  if (!text) return '';
  return parsePartialDate(text).iso ?? normalizeKey(text);
}

/**
 * A lab value's part of a key, read as printed (shared labvalues): a plain number keys as today ("62" -> "62"), a limit
 * keeps its sign ("<3" -> "lt 3", never "3"), a negative number keeps its minus ("-2" -> "neg 2"), words as today.
 */
export function labValueDedupKey(value: string | null | undefined): string {
  return labDedupValueKey(parseLabValue(value ?? ''));
}

/**
 * A lab value's identity (shared labvalues labValueIdentity): "62" = "62.0", but ".8" is not "8" and "1,500" is not
 * "1.500", which the stored key (it drops the point and the comma) cannot tell apart. Two lab values are one only when
 * both their key and their identity agree, so a 10x or 1000x typo is never folded into the other value (rule 10).
 */
export function labValueIdentityOf(value: string | null | undefined): string {
  return labValueIdentity(parseLabValue(value ?? ''));
}

/** A unit's part of a key: as today, except that µ/μ reads as "u" ("µg/mL" no longer keys as "g/mL"). */
export function unitDedupKey(unit: string | null | undefined): string {
  return normalizeKey((unit ?? '').replace(/[µμ]/g, 'u'));
}

/** The subject part of the key, per type. Empty string when the type has no usable subject. */
function subjectParts(f: KeyableFact): string[] {
  const a = f.attributes ?? {};
  switch (f.type) {
    case 'lab_result':
      return [str(a, 'analyte')];
    case 'medication':
      return [str(a, 'name')];
    case 'diagnosis':
      return [str(a, 'name')];
    case 'imaging_result':
      return [str(a, 'modality'), str(a, 'body_part')];
    case 'procedure':
      return [str(a, 'name')];
    case 'symptom':
      return [str(a, 'name')];
    case 'record_reference':
      return [str(a, 'record_type'), str(a, 'description')];
    case 'follow_up':
      return [str(a, 'what')];
    case 'recommendation':
      return [str(a, 'action')];
    case 'referral':
      return [str(a, 'to')];
    case 'clinician_statement':
      return [str(a, 'stated_by'), str(a, 'about')];
    case 'event':
      return [str(a, 'name')];
    case 'vital':
      return [str(a, 'name')];
    case 'allergy_intolerance':
      return [str(a, 'substance')];
    default:
      return [];
  }
}

/**
 * The rest of the key, per type: the value and date at their precision, and
 * for assessments the attribute that carries the meaning, so a "possible" and
 * a "ruled out" diagnosis, or a clinician supporting and opposing a treatment,
 * never share a key.
 */
function dateParts(f: KeyableFact): string[] {
  const a = f.attributes ?? {};
  switch (f.type) {
    case 'lab_result':
      // "<3" never shares a key with "3" (rule 2): a limit is not a measurement, in a run or across documents.
      return [labValueDedupKey(str(a, 'value')), unitDedupKey(str(a, 'unit')), dateKey(f.date)];
    case 'medication':
      return [dateKey(str(a, 'start_date') || f.date)];
    case 'diagnosis':
      return [normalizeKey(str(a, 'certainty'))];
    case 'allergy_intolerance':
      return [];
    case 'clinician_statement':
      return [normalizeKey(str(a, 'stance')), dateKey(f.date)];
    case 'imaging_result':
    case 'procedure':
    case 'symptom':
    case 'recommendation':
    case 'referral':
    case 'event':
      return [dateKey(f.date)];
    case 'record_reference':
      return [dateKey(str(a, 'record_date') || f.date)];
    case 'follow_up':
      return [dateKey(str(a, 'due') || f.date)];
    case 'vital':
      return [normalizeKey(str(a, 'value')), dateKey(f.date)];
    default:
      return [dateKey(f.date)];
  }
}

/** type|subject — for grouping. */
export function subjectKey(f: KeyableFact): string {
  const parts = subjectParts(f).map(normalizeKey);
  return [f.type, ...parts].join('|');
}

/** type|subject|…|date — identical keys from different documents are proposed as the same fact. */
export function dedupKey(f: KeyableFact): string {
  const subj = subjectParts(f).map(normalizeKey);
  return [f.type, ...subj, ...dateParts(f)].join('|');
}

// ---------------------------------------------------------------------------
// "The same fact" inside one extraction (and against facts a re-run keeps)
// ---------------------------------------------------------------------------

/** A fact as compared for in-run dedup: what it says, not where it sits. */
export interface ComparableFact {
  type: string;
  statement: string;
  attributes: Record<string, unknown> | null | undefined;
  /** ISO partial date of the fact. */
  date: string | null;
}

/**
 * Attributes that carry the meaning of a fact beyond its subject: two facts
 * on one subject that differ here say different things (possible vs ruled
 * out, supports vs opposes, started vs stopped, improved vs no benefit).
 */
const MEANING_KEYS: Record<string, string[]> = {
  diagnosis: ['certainty'],
  allergy_intolerance: ['kind', 'reaction', 'severity'],
  clinician_statement: ['stance'],
  medication: ['dose', 'status', 'effect'],
  symptom: ['course', 'severity'],
  record_reference: ['present_in_this_document'],
  referral: ['status'],
  follow_up: ['status'],
  recommendation: ['acted_on'],
};

/**
 * Labels that tell two measurements apart only when both sides carry one: two samples of one test labelled on the page
 * (tube 1 / tube 4, a time, "repeat") are two measurements even with one value; a fact read before the label existed
 * (2026-10) carries none and still matches its re-extracted copy.
 */
const SLOT_KEYS: Record<string, string[]> = {
  lab_result: ['sample_label'],
};

/** Types whose key already holds the measured value, unit and date: an equal key is the same measurement. */
const VALUE_KEYED = new Set(['lab_result', 'vital']);

function meaning(v: unknown): string {
  if (v == null) return '';
  return normalizeKey(typeof v === 'string' ? v : String(v));
}

/**
 * Pure rule: is `b` a repeat of `a` (the same statement seen twice, e.g. across
 * a chunk boundary or re-extracted from a kept fact), rather than a different
 * statement that happens to share a dedupKey? All of these must hold:
 * - same dedupKey, and the key has a real subject (a clinician statement with
 *   no speaker and no topic is never "the same" as another one);
 * - the meaning-bearing attributes agree;
 * - the dates agree at their precision;
 * - the statements are similar (Dice >= STATEMENT_SIMILARITY_THRESHOLD), except
 *   for measurements whose key already carries value, unit and date.
 * When any of these fails both facts are kept: a contradiction must surface,
 * never be folded into the other fact's provenance.
 */
export function sameFact(a: ComparableFact, b: ComparableFact): boolean {
  if (a.type !== b.type) return false;
  const ka = { type: a.type, attributes: a.attributes, date: a.date };
  const kb = { type: b.type, attributes: b.attributes, date: b.date };
  if (!hasSubject(subjectKey(ka))) return false;
  if (dedupKey(ka) !== dedupKey(kb)) return false;
  for (const key of MEANING_KEYS[a.type] ?? []) {
    if (meaning(a.attributes?.[key]) !== meaning(b.attributes?.[key])) return false;
  }
  for (const key of SLOT_KEYS[a.type] ?? []) {
    const la = meaning(a.attributes?.[key]);
    const lb = meaning(b.attributes?.[key]);
    if (la && lb && la !== lb) return false;
  }
  if (!datesAgree(a.date, b.date)) return false;
  // The stored key reads ".8" as "8" and "1,500" as "1.500": a lab value is the same only when its identity is too.
  if (a.type === 'lab_result' && labValueIdentityOf(str(a.attributes ?? {}, 'value')) !== labValueIdentityOf(str(b.attributes ?? {}, 'value'))) return false;
  if (VALUE_KEYED.has(a.type)) return true;
  return textSimilarity(a.statement, b.statement) >= STATEMENT_SIMILARITY_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Merge proposals
// ---------------------------------------------------------------------------

export interface MergeCandidateFact {
  id: string;
  statement: string;
  date: string | null;
  dedupKey: string | null;
  subjectKey: string | null;
  sourceDocumentId: string | null;
  extractionRunId: string | null;
}

export interface MergeProposal {
  otherId: string;
  similarity: number;
  reason: string;
}

/**
 * Pure rule: should `a` (new) and `b` (existing) be proposed as duplicates?
 * - never two facts from the same extraction run
 * - identical dedupKey from a different document -> 1.0, 'same key'
 * - same subjectKey, dates agree, statements similar -> that similarity
 */
export function proposeMerge(a: MergeCandidateFact, b: MergeCandidateFact): MergeProposal | null {
  if (a.id === b.id) return null;
  if (a.extractionRunId && b.extractionRunId && a.extractionRunId === b.extractionRunId) return null;
  if (a.dedupKey && b.dedupKey && a.dedupKey === b.dedupKey && a.sourceDocumentId !== b.sourceDocumentId) {
    return { otherId: b.id, similarity: 1, reason: 'same key' };
  }
  if (a.subjectKey && b.subjectKey && a.subjectKey === b.subjectKey && datesAgree(a.date, b.date)) {
    const sim = textSimilarity(a.statement, b.statement);
    if (sim >= STATEMENT_SIMILARITY_THRESHOLD) {
      return { otherId: b.id, similarity: Math.round(sim * 1000) / 1000, reason: 'same subject, similar statement' };
    }
  }
  return null;
}

/**
 * Live, mergeable facts that share a dedupKey or subjectKey with `f`. The
 * candidate's dedupKey is recomputed from its row, so rows stored before the
 * key gained certainty/stance compare on the current rule (no row rewrite).
 */
export function findMergeCandidates(f: MergeCandidateFact): MergeCandidateFact[] {
  const d = db();
  const conds = [];
  if (f.dedupKey) conds.push(eq(schema.facts.dedupKey, f.dedupKey));
  if (f.subjectKey) conds.push(eq(schema.facts.subjectKey, f.subjectKey));
  if (!conds.length) return [];
  const rows = d
    .select({
      id: schema.facts.id,
      type: schema.facts.type,
      attributesJson: schema.facts.attributesJson,
      statement: schema.facts.statement,
      date: schema.facts.date,
      dedupKey: schema.facts.dedupKey,
      subjectKey: schema.facts.subjectKey,
      sourceDocumentId: schema.facts.sourceDocumentId,
      extractionRunId: schema.facts.extractionRunId,
    })
    .from(schema.facts)
    .leftJoin(schema.documents, eq(schema.documents.id, schema.facts.sourceDocumentId))
    .where(
      and(
        ne(schema.facts.id, f.id),
        isNull(schema.facts.deletedAt),
        ne(schema.facts.status, 'superseded'),
        or(isNull(schema.documents.id), isNull(schema.documents.deletedAt)),
        or(...conds),
      ),
    )
    .limit(200)
    .all();
  return rows.map(({ type, attributesJson, ...r }) => ({ ...r, dedupKey: keysForRow({ type, attributesJson, date: r.date }).dedupKey }));
}

/**
 * Compare a freshly inserted fact against the ledger and write pending
 * `fact_merges` rows. Returns how many were proposed. `skipIds` are facts
 * about to be retired (the previous unverified pass of the same document
 * during a re-run): pairing with them would only leave proposals that the
 * retirement then closes.
 */
export function proposeMergesFor(f: MergeCandidateFact, opts: { skipIds?: ReadonlySet<string> } = {}): number {
  if (!hasSubject(f.subjectKey)) return 0;
  const d = db();
  let n = 0;
  for (const other of findMergeCandidates(f)) {
    if (opts.skipIds?.has(other.id)) continue;
    const p = proposeMerge(f, other);
    if (!p) continue;
    const exists = d
      .select({ id: schema.factMerges.id })
      .from(schema.factMerges)
      .where(
        or(
          and(eq(schema.factMerges.factIdA, other.id), eq(schema.factMerges.factIdB, f.id)),
          and(eq(schema.factMerges.factIdA, f.id), eq(schema.factMerges.factIdB, other.id)),
        ),
      )
      .get();
    if (exists) continue;
    // A is the older fact already in the ledger, B is the newcomer.
    d.insert(schema.factMerges)
      .values({ id: newId(), factIdA: other.id, factIdB: f.id, reason: p.reason, similarity: p.similarity, status: 'pending', createdAt: nowIso() })
      .run();
    n++;
  }
  return n;
}

/** Decide every pending proposal that involves this fact (used when a fact is deleted or superseded). */
export function closePendingMergesFor(factId: string, status: 'rejected' | 'accepted' = 'rejected'): number {
  const r = db()
    .update(schema.factMerges)
    .set({ status, decidedAt: nowIso() })
    .where(and(eq(schema.factMerges.status, 'pending'), or(eq(schema.factMerges.factIdA, factId), eq(schema.factMerges.factIdB, factId))))
    .run();
  return r.changes;
}

/** Convenience for callers holding a facts row. */
export function keysForRow(row: { type: string; attributesJson: string; date: string | null }): { dedupKey: string; subjectKey: string } {
  const attributes = parseJson<Record<string, unknown>>(row.attributesJson, {});
  const k: KeyableFact = { type: row.type, attributes, date: row.date };
  return { dedupKey: dedupKey(k), subjectKey: subjectKey(k) };
}

/** A key with nothing after the type (e.g. a manual fact with no attributes) must not drive proposals. */
export function hasSubject(key: string | null | undefined): boolean {
  if (!key) return false;
  return key.split('|').slice(1).some((p) => p.trim().length > 0);
}
