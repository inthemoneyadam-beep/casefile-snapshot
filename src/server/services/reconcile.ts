/**
 * Quiet checks and reconciliation.
 *
 * Nothing waits for approval by default. Every measurement-like detail (a lab
 * result, an imaging result, a vital, a procedure, or an event such as an ER
 * visit or an admission) gets an automatic trust level (src/shared/reconcile.ts):
 *
 * - verified: a fact of a clinical record (a live document of source tier `primary`);
 * - accurate: a mention elsewhere (a call, a summary, notes, a letter) that records the
 *   same thing on the same date with the same value as a verified one; or the user said so;
 * - inaccurate: a mention that contradicts a verified one: a different value on the same
 *   day, or a date near the record's that differs (a lab within 3 days; a procedure, scan or
 *   event within 7; a vital only on its own day); or the user said it is wrong;
 * - conflict: a pending mention of an event whose mentions disagree with each other and no
 *   clinical record settles it ("needs a source"); or clinical records from different documents
 *   that disagree with each other (a lab or vital whose values that day share none; a procedure,
 *   event or scan whose dates within the window share none), with every mention of that event,
 *   until the user says which one is right or that both happened;
 * - unbacked: nothing to compare it with yet; replaced: a newer reading or a merge stands in.
 *
 * Names fold by content (eventNameKey); a repeated treatment (an infusion, plasma exchange, a
 * therapy session) or a named repeat ("Repeat LP", "LP #2") is compared on its own day only; a lab
 * that names no specimen meets the records of its day when they all have one specimen (never a CSF
 * record for a test named as a blood test, never a record in another unit). A correction reaches
 * only its own event.
 *
 * Values: spellings of one unit are one unit (IU/L = U/L, bpm = /min, °C = C, % = percent, mEq/L =
 * mmol/L for the monovalent ions); units that scale (mass per volume, cell counts, cmH2O and mmH2O)
 * are converted; other units, and results in words that are no known answer, are not compared
 * (neither accurate nor inaccurate); an equal number in two units known to differ is not a copy. Scan
 * impressions are not judged by their wording: the same date decides it is the same scan, and the
 * impression is the same only when worded nearly identically (sameWording), otherwise not compared,
 * with the report's words in the reason ("Read both."); on a day with the scan report, a clinic note's
 * scan worded otherwise is not compared either, and is no record to match. A value not compared with the record of its
 * day says so, with what the record gives ("Not compared: ..."), and is not listed as waiting for a
 * record, unless such values disagree with each other between documents (they need a source). A lab
 * that names no sample on a day whose records give the test for several samples is not compared either.
 *
 * Lab values as printed (2026-10): a lab value is read by the shared parser (src/shared/labvalues.ts), units by the
 * shared unit key and conversions. A value with a sign ("<3", ">1700") is a limit, not a measurement: the record's
 * limit against a measurement inside it is inaccurate (the mention gives a measurement the report does not contain);
 * a mention's limit against the record's measurement inside it is not compared; a value printed in words, as a range
 * or a titre is never read from the number stored beside it. A mention dated on the day a lab record's report printed
 * as resulted matches that record (rule 7). A value in another unit that converts is named in both units.
 *
 * The same comparison drives the pass that writes (reconcileAll): a secondhand
 * fact still pending, extracted by the model, with no edit, no note and never
 * taken back by the user, that matches a verified fact (same day, a near day, or
 * a month/year copy) is set aside (status `superseded`, `superseded_by_id` = the
 * verified fact) and linked by a `fact_merges` row (reason `clinical record`,
 * A = the verified fact, B = the mention, similarity 1 for a copy and 0 for a
 * disagreement, status `accepted`). When the link stops holding the pass puts
 * the fact back to pending and matches it again. When the user decides about a
 * set-aside fact (a verdict, a supersede or merge by hand, an edit or a note) the
 * row becomes `rejected` with reason `clinical record (taken back)`: the fact is
 * the user's from then on, until the user puts it back to automatic (resetMention).
 *
 * The patient's own word can correct a clinical inaccuracy (correctRecord): the
 * chosen mention becomes the truth for its event (status confirmed, basis
 * `correction`, the reason as its note). The record's conflicting fact is then
 * shown inaccurate with the patient's reason, but is never set aside or changed:
 * a clinical record's own fact is never superseded automatically.
 *
 * The pass no longer drafts findings: the Reconciliation page replaces them,
 * and the pass's open findings (rule `clinical_record`) are resolved
 * automatically ("Moved to Reconciliation"). Trust, events and counts are
 * computed on read from the whole ledger and cached by a cheap signature, so the
 * page can be polled.
 */
import { and, eq, inArray, isNull, ne, notInArray, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { db, schema } from '../db';
import { newId, normalizeKey, nowIso, parseJson } from '../util/ids';
import { badRequest, conflict, notFound } from '../util/errors';
import { daysBetween, dateSortKey, formatPartialDate, parsePartialDate } from '../../shared/dates';
import { NEAR_DAYS, RECONCILE_TYPES, isRepeatedTreatment, type InaccurateItem, type Mention, type ReconcileCounts, type ReconcileEvent, type ReconcileState, type ReconcileType, type TrustInfo } from '../../shared/reconcile';
import { convertValue, fmtNum, parseLabValue, parseUnit, unitKey, type Comparator } from '../../shared/labvalues';
import { analyteLabel, defaultSpecimenFor, normalizeAnalyte, readLabLine } from './labs';
import { canonicalModality, normalizeBodyPart } from './imaging';
import { resolveRuleFindings } from './findings';
import { categoryForSegmentKind, epicOrderKey, passageSourceUnitsOn, segmentIdOf, segmentKindOf, sourceKeyOf } from './source-unit';
import { factTier } from '../../shared/trust';
import { setVerdict } from './facts';
import { updateDocument } from './documents';
import { onLockChange } from '../auth';

export const RECONCILED_TYPES = RECONCILE_TYPES;
const RECONCILED = new Set<string>(RECONCILED_TYPES);

/** `fact_merges.reason` of an automatic clinical-record link. */
export const CLINICAL_RECORD_REASON = 'clinical record';
/** `fact_merges.reason` of a clinical-record link the user took back (status `rejected`). */
export const CLINICAL_RECORD_TAKEN_BACK = 'clinical record (taken back)';
const LINK_REASONS = [CLINICAL_RECORD_REASON, CLINICAL_RECORD_TAKEN_BACK];
/** `findings.rule_id` of the disagreements the pass used to raise (now resolved automatically). */
export const CLINICAL_RECORD_RULE = 'clinical_record';
/** Why the pass resolves its old findings. */
export const MOVED_TO_RECONCILIATION = 'Moved to Reconciliation.';

/** A fact the user said is not the same event as the details near it: compared on its own date only. */
export const SEPARATE_MARKER = '_reconcileSeparate';

export function isReconciledType(type: string | null | undefined): boolean {
  return Boolean(type && RECONCILED.has(type));
}

/**
 * Is this fact the secondhand side of a clinical-record link (any status,
 * taken back too) or of an open disagreement finding? A verdict on it changes
 * what the pass does with it, so the verdict re-runs it.
 */
export function isSecondhandInReconcile(factId: string): boolean {
  const d = db();
  if (d.get(sql`select 1 as x from fact_merges where reason in (${CLINICAL_RECORD_REASON}, ${CLINICAL_RECORD_TAKEN_BACK}) and fact_id_b = ${factId} limit 1`)) return true;
  return Boolean(
    d.get(sql`select 1 as x from finding_evidence fe join findings f on f.id = fe.finding_id
              where f.rule_id = ${CLINICAL_RECORD_RULE} and f.deleted_at is null and fe.fact_id = ${factId} and fe.sort_order = 1 limit 1`),
  );
}

/**
 * The user decided about a fact the pass had set aside (a verdict, a supersede
 * or merge by hand): its accepted link becomes `rejected`, reason
 * `clinical record (taken back)`, so the pass treats the fact as checked from
 * now on and never reads a later supersede by hand as its own. The caller
 * writes the fact's new status. Returns how many links were taken back.
 */
export function takeBackClinicalLink(factId: string, now: string = nowIso()): number {
  return db()
    .update(schema.factMerges)
    .set({ status: 'rejected', reason: CLINICAL_RECORD_TAKEN_BACK, decidedAt: now })
    .where(and(eq(schema.factMerges.reason, CLINICAL_RECORD_REASON), eq(schema.factMerges.status, 'accepted'), eq(schema.factMerges.factIdB, factId)))
    .run().changes;
}

/**
 * SQL condition: the fact with this id is set aside by the pass right now
 * (superseded by the fact its accepted link names). Used to hide the duplicate
 * proposals that involve it.
 */
export function passSetAsideSql(factIdColumn: SQLWrapper): SQL {
  return sql`exists (select 1 from facts psf join fact_merges psm on psm.fact_id_b = psf.id and psm.fact_id_a = psf.superseded_by_id
                     where psf.id = ${factIdColumn} and psf.status = 'superseded' and psm.reason = ${CLINICAL_RECORD_REASON} and psm.status = 'accepted')`;
}

/**
 * SQL condition: both facts of a possible-duplicate pair are of reconciled types (lab results, scans, vitals,
 * procedures, events). Reconciliation groups those (one event, every mention), so a pending pair of them is left
 * out of the Possible duplicates queue and its count; decided pairs stay in the history.
 */
export function reconciledPairSql(factIdA: SQLWrapper, factIdB: SQLWrapper): SQL {
  const types = sql.join(
    RECONCILED_TYPES.map((t) => sql`${t}`),
    sql`, `,
  );
  return sql`(exists (select 1 from facts rpa where rpa.id = ${factIdA} and rpa.type in (${types}))
              and exists (select 1 from facts rpb where rpb.id = ${factIdB} and rpb.type in (${types})))`;
}

/** Ids, among these, of facts the pass has set aside right now. */
export function passSetAsideIds(ids: string[]): Set<string> {
  const out = new Set<string>();
  const want = [...new Set(ids.filter(Boolean))];
  const f = schema.facts;
  const m = schema.factMerges;
  for (let i = 0; i < want.length; i += 400) {
    const rows = db()
      .select({ id: f.id })
      .from(f)
      .innerJoin(m, and(eq(m.factIdB, f.id), eq(m.factIdA, f.supersededById)))
      .where(and(inArray(f.id, want.slice(i, i + 400)), eq(f.status, 'superseded'), eq(m.reason, CLINICAL_RECORD_REASON), eq(m.status, 'accepted')))
      .all();
    for (const r of rows) out.add(r.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// What a measurement is about, and what it says
// ---------------------------------------------------------------------------

interface Value {
  /** Nothing to compare (no value, no impression, or a procedure / event). */
  empty: boolean;
  /** The number stated (after a qualifier, if any). */
  num: number | null;
  /**
   * Qualifier before the number: '' | lt | le | gt | ge. A value with one is a limit, not a measurement ("<3": the
   * test reads below 3); relate compares limits as limits ("<5" is not ">5" and not "5"; "<3" against 2 is not compared).
   */
  qual: string;
  /** Normalised text of the value (or impression), qualifier symbols spelled out. */
  text: string;
  /** The unit's key, for comparing only (shared unitKey; mEq/L read as mmol/L for a monovalent ion). Never shown. */
  unit: string;
  /** The unit as written (trimmed), for the words: a converted value is named in the other side's own unit. */
  unitShown?: string;
  /** As shown to the user. */
  display: string;
  /** Digits after the decimal point in the number as written ("1.08" -> 2, "62" -> 0); null without a number. */
  dec?: number | null;
  /** A result in words that reads as a known answer ("Negative", "No growth at 72 hours", "WNL"); null otherwise. */
  answer?: Answer | null;
  /** Numbers written together that no one number stands for: a ratio, a range or a titre ("128/82", "5-10", "1:160"). */
  ratio?: boolean;
  /** A scan impression as written (the reason quotes it when it is not compared). */
  words?: string;
  /** A scan impression's words for comparing (wordingOf). */
  wording?: Wording;
  /**
   * A lab line that holds several tests ("CSF opening pressure / protein: OP 17; protein 52", labs.ts readLabLine): it
   * is never compared part by part here, and as a whole only with the same line written the same, so one differing
   * part never sets the whole line aside.
   */
  several?: boolean;
}

/** How two values of one subject compare: clearly the same, clearly different, or not comparable (another unit, other words). */
type Relation = 'same' | 'different' | 'unknown';

/** A known answer in words: its family (negative/positive, normal/abnormal) and which side of it. */
interface Answer {
  family: 'np' | 'na';
  side: string;
}

interface MFact {
  id: string;
  type: ReconcileType;
  statement: string;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  status: string;
  verdictBasis: string | null;
  verdictNote: string | null;
  verdictAt: string | null;
  supersededById: string | null;
  origin: string;
  createdAt: string;
  documentId: string;
  documentTitle: string;
  documentCategory: string;
  /** The tier the fact is trusted at: its passage's (trust.ts factTier; never above its document's). */
  tier: string;
  /**
   * Its source unit for "same source" (source-unit.ts): the document, or the document and its passage of an export
   * (2026-10-07). Two facts with the same key never contest or back each other; a fact with no passage is the whole
   * document, as before.
   */
  sourceKey: string;
  userEdited: boolean;
  /** The user said this is not the same event as the details near it. */
  separate: boolean;
  /** Its own document gives the same subject on another day close by: two occurrences, compared on their own dates. */
  multi: boolean;
  /** Subject key (type, normalised subject, specimen); null when the fact names no usable subject. */
  key: string | null;
  label: string;
  value: Value;
  /** Days it may be from a record and still be the same event (NEAR_DAYS; 0 for a vital or a repeated treatment). */
  window: number;
  /**
   * A lab result's resulted (reported) day as its document prints it (attributes.resulted_date read to a full day),
   * when it is not the fact's own date: a mention dated on it is about this result (findMatch). Null otherwise.
   */
  resultedDay: string | null;
  /** A lab result that does not say (or imply) its specimen: its analyte as written, else null. */
  unknownSpecimenAnalyte: string | null;
  /**
   * Such a lab result on a day whose clinical records give that test for several samples (CSF glucose and serum
   * glucose): the subject keys of those records. It is not compared with any of them (it does not name the sample).
   */
  sampleKeys: string[] | null;
  /** The patient's reason for a correction (the note without the earlier note kept beside it). */
  reasonNote: string | null;
  /** A correction the user chose beside a record it says nothing against (Ledger.chosen): named "the value you chose". */
  chosenValue?: boolean;
}

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

const STATED_SPECIMEN: Record<string, string> = { serum: 'serum', plasma: 'plasma', 'whole blood': 'whole_blood', whole_blood: 'whole_blood', blood: 'whole_blood', csf: 'csf', 'cerebrospinal fluid': 'csf', 'spinal fluid': 'csf', urine: 'urine', other: 'other' };

/**
 * The specimen a lab result is about: as stated, else what the analyte name
 * itself implies ("CSF protein", "IgG index", "serum sodium"), else unknown.
 */
export function specimenOf(stated: unknown, analyte: string): string {
  const s = normalizeKey(str(stated));
  if (s) return STATED_SPECIMEN[s] ?? STATED_SPECIMEN[s.replace(/ /g, '_')] ?? 'other';
  const name = normalizeKey(analyte);
  if (defaultSpecimenFor(analyte) === 'csf') return 'csf';
  if (/\bserum\b/.test(name)) return 'serum';
  if (/\bplasma\b/.test(name)) return 'plasma';
  if (/\b(urine|urinary)\b/.test(name)) return 'urine';
  if (/\bwhole blood\b/.test(name)) return 'whole_blood';
  return 'unknown';
}

/** Specimens a blood test is reported on; unknown is one of them for a name no CSF test shares. */
const BLOOD_SPECIMENS = new Set(['unknown', 'serum', 'plasma', 'whole_blood']);
/** Words a blood test shares with a CSF test: the specimen must be stated (or implied) to tell those apart. */
const CSF_SHARED_WORDS = /\b(protein|glucose|albumin|igg|wbc|white|leukocytes?|rbc|red|erythrocytes?|lactate|lactic|cells?|cell count)\b/;

/**
 * A test named as a blood test ("Blood glucose", "Fasting glucose", "POC glucose", "Blood WBC", "Arterial lactate"):
 * never a CSF test, whatever else the day holds. "White blood cells" and "blood count" are not: CSF has those too.
 */
const BLOOD_NAMED = /\b(?:fasting|random|capillary|venous|arterial|fingerstick|finger stick|poc|point of care)\b|\bblood\b(?!\s+cells?\b|\s+counts?\b)/;

/** Is this analyte name one a CSF test also uses ("protein", "glucose", "WBC", "cell count")? */
export function sharedWithCsf(analyte: string): boolean {
  return CSF_SHARED_WORDS.test(normalizeKey(analyte)) || normalizeAnalyte(analyte, 'csf') !== normalizeAnalyte(analyte, null);
}

/**
 * The specimen bucket two lab results must share: a blood test whose name no
 * CSF test shares (sodium, hemoglobin, ferritin) is 'blood' whether the report
 * says serum, plasma, whole blood or nothing; any other is its specimen as
 * stated or implied, and an unknown one only meets another unknown one.
 */
export function specimenBucket(stated: unknown, analyte: string): string {
  const specimen = specimenOf(stated, analyte);
  if (BLOOD_SPECIMENS.has(specimen) && defaultSpecimenFor(analyte) === 'serum' && !sharedWithCsf(analyte)) return 'blood';
  return specimen;
}

const HEAD_WORDS = /\b(brain|head|cranial|intracranial|cerebral|cerebrum|skull)\b/;
const NECK_WORDS = /\b(neck|carotids?)\b/;
const SPINE_WORDS = /\b(spine|spinal|cervical|thoracic|lumbar|lumbosacral|c spine|t spine|l spine)\b/;
const VENO_WORDS = /\b(mrv|ctv|venogra(m|ms|phy)|venous angiography)\b/;
const ANGIO_WORDS = /\b(mra|cta|angio|angiogra(m|ms|phy)|arteriogra(m|ms|phy)|dsa)\b/;

/** Angiography and venography are their own studies, never the plain MRI or CT of that day. */
function imagingKind(modality: string, part: string): '' | 'angio' | 'veno' | 'angio+veno' {
  const t = normalizeKey(`${modality} ${part}`);
  const veno = VENO_WORDS.test(t);
  const angio = ANGIO_WORDS.test(t.replace(VENO_WORDS, ' '));
  return angio && veno ? 'angio+veno' : veno ? 'veno' : angio ? 'angio' : '';
}

/** The body part, as the imaging normaliser reads it, except that the head with the neck (or the spine) is a study of its own, not a brain study. */
export function imagingBodyPart(raw: string): { key: string; label: string } {
  const k = normalizeKey(raw);
  if (HEAD_WORDS.test(k) && NECK_WORDS.test(k)) return { key: 'head and neck', label: 'Head and neck' };
  if (HEAD_WORDS.test(k) && SPINE_WORDS.test(k)) return { key: 'brain and spine', label: 'Brain and spine' };
  return normalizeBodyPart(raw);
}

const KIND_LABEL: Record<string, Record<string, string>> = {
  angio: { MRI: 'MRA', CT: 'CTA' },
  veno: { MRI: 'MRV', CT: 'CTV' },
};

/** The canonical names a procedure or event is folded into, however it is written (shown by these words). */
const CANONICAL_NAMES = new Set(['lumbar puncture', 'emergency visit', 'admission']);
/**
 * Words that only qualify how a lumbar puncture, an emergency visit or an admission was done, taken off only to
 * recognise those three. Any other name keeps them: a CT-guided biopsy is not an ultrasound-guided one, and a
 * repeat EMG is not the EMG before it.
 */
const NAME_QUALIFIERS =
  /\b(fluoroscopy guided|fluoroscopically guided|fluoroscopic(?:ally)?|fluoroscopy|ct guided|ultrasound guided|us guided|image guided|guided|diagnostic|therapeutic|bedside|with opening pressures?|opening pressures?|with op|repeat|repeated|attempted)\b/g;
/** Spinal levels: "L3-L4", "L4/5", "L5-S1", "at L4" (taken off only to recognise a lumbar puncture). */
const SPINAL_LEVELS = /\b[ltcs]\d{1,2}\s*(?:[-/–—]|to)\s*[ltcs]?\d{1,2}\b|\b[ltcs]\d{1,2}\b/g;
/** A lumbar puncture, however written. */
const LP_WORDS = /\b(lumbar puncture|spinal tap|lp)\b/;
/** Not the puncture itself: a drain, a shunt, a myelogram or cisternogram done through one, a blood patch, a headache or a leak after one. */
const NOT_LP = /\b(drains?|drainage|shunts?|catheters?|myelogra\w*|cisternogra\w*|patch|headaches?|leaks?|complications?|post|after)\b/;
/** An emergency visit, once "visit", "presentation" and the like are taken off. */
const EMERGENCY_NAMES = new Set(['er', 'ed', 'emergency', 'emergency room', 'emergency department', 'emergency dept', 'a e', 'accident and emergency']);
const EMERGENCY_FILLER = /\b(visits?|presentations?|presented to|went to|trip to|trip|attendance|seen in|seen at|in|at|to|the|an)\b/g;
/** A hospital admission (an ICU or rehab admission is its own event). */
const ADMISSION_NAMES = new Set(['admission', 'admitted', 'hospital admission', 'inpatient admission', 'hospitalization', 'hospitalisation', 'admitted to hospital', 'admitted to the hospital', 'admission to hospital', 'hospital stay', 'inpatient stay']);

/**
 * The subject key of a procedure or event name. Three names are recognised by content, with bracketed text, spinal
 * levels and qualifier words ("fluoroscopy-guided", "diagnostic", "with opening pressure", "repeat", "attempted")
 * taken off: anything that is a lumbar puncture ("LP", "spinal tap", "Lumbar puncture (L4-L5)") is "lumbar
 * puncture" (a lumbar drain, an LP shunt, a myelogram via LP, a blood patch or a post-LP headache is not); an ER /
 * ED / emergency department or room visit is "emergency visit"; a hospital or inpatient admission is "admission".
 * Any other name is kept whole (normalised spelling only), so different procedures never meet.
 */
export function eventNameKey(raw: string): string {
  const plain = normalizeKey(raw);
  let t = (raw ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .replace(/\ba\s*&\s*e\b|\baccident and emergency\b/g, ' emergency ')
    .replace(SPINAL_LEVELS, ' ');
  t = normalizeKey(t).replace(NAME_QUALIFIERS, ' ').replace(/\s+/g, ' ').trim();
  // Words left hanging by what was taken off ("lumbar puncture at", "with").
  for (let i = 0; i < 3; i++) t = t.replace(/^(?:a|an|the|with|at|of|on|and)\s+|\s+(?:a|an|the|with|at|of|on|and|level|levels)$/g, '').trim();
  if (!t || /^(?:a|an|the|with|at|of|on|and|level)$/.test(t)) t = plain;
  if (LP_WORDS.test(t) && !NOT_LP.test(t)) return 'lumbar puncture';
  if (EMERGENCY_NAMES.has(t.replace(EMERGENCY_FILLER, ' ').replace(/\s+/g, ' ').trim()) || t === 'emergency visit') return 'emergency visit';
  if (ADMISSION_NAMES.has(t)) return 'admission';
  return plain;
}

function subjectOf(type: string, a: Record<string, unknown>): { key: string | null; label: string } {
  switch (type) {
    case 'lab_result': {
      const analyte = str(a.analyte);
      if (!analyte) return { key: null, label: '' };
      const specimen = specimenOf(a.specimen, analyte);
      const k = normalizeAnalyte(analyte, specimen === 'unknown' ? null : specimen);
      return { key: k ? `lab|${k}|${specimenBucket(a.specimen, analyte)}` : null, label: analyteLabel(k, analyte) };
    }
    case 'imaging_result': {
      const modality = canonicalModality(str(a.modality));
      const part = imagingBodyPart(str(a.body_part));
      if (modality === 'other' && !part.key) return { key: null, label: '' };
      const kind = imagingKind(str(a.modality), str(a.body_part));
      const modLabel = (kind && KIND_LABEL[kind]?.[modality]) || [modality === 'other' ? str(a.modality) || 'Imaging' : modality, kind ? kind.replace('angio', 'angiography').replace('veno', 'venography').replace('+', ' and ') : ''].filter(Boolean).join(' ');
      const label = [modLabel, part.key ? part.label.toLowerCase() : ''].filter(Boolean).join(' ');
      return { key: `imaging|${modality}${kind ? `|${kind}` : ''}|${part.key}`, label };
    }
    case 'vital': {
      const name = normalizeKey(str(a.name));
      return { key: name ? `vital|${name}` : null, label: str(a.name) };
    }
    case 'procedure':
    case 'event': {
      // An event without a usable kind or name (no subject) is not reconciled. A name with a common spelling ("LP",
      // "ER visit") is shown by that spelling ("Lumbar puncture", "Emergency visit").
      const raw = str(a.name);
      const name = eventNameKey(raw);
      const canonical = CANONICAL_NAMES.has(name) && name !== normalizeKey(raw);
      return { key: name ? `${type}|${name}` : null, label: canonical ? name.charAt(0).toUpperCase() + name.slice(1) : raw };
    }
    default:
      return { key: null, label: '' };
  }
}

/**
 * A qualifier before the number of a vital sign, and how it is compared. A lab result's sign is read by the shared
 * parser (parseLabValue, src/shared/labvalues.ts) instead, with every spelling it knows ("> OR = 60", ">/=", "≤").
 */
const QUALIFIER_PREFIX = /^(less than or equal to|greater than or equal to|less than|fewer than|greater than|more than|up to|above|below|under|over|<=|>=|=<|=>|≤|≥|<|>)\s*/i;
/** A lab result's printed sign (parseLabValue's comparator) as the qualifier relate compares. */
const QUALIFIER_OF: Record<Comparator, string> = { '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
const QUALIFIER_WORD: Record<string, string> = {
  '<': 'lt', 'less than': 'lt', 'fewer than': 'lt', below: 'lt', under: 'lt',
  '<=': 'le', '=<': 'le', '≤': 'le', 'up to': 'le', 'less than or equal to': 'le',
  '>': 'gt', 'greater than': 'gt', 'more than': 'gt', above: 'gt', over: 'gt',
  '>=': 'ge', '=>': 'ge', '≥': 'ge', 'greater than or equal to': 'ge',
};
/** A flag written after the value: H, L, (H), (L), (N), [H], *, high, low, abnormal, critical. */
const FLAG_TAIL = /\s*(?:\(\s*(?:h|l|hh|ll|a|n|high|low|normal|abn|abnormal|crit|critical)\s*\)|\[\s*(?:h|l|hh|ll|a|n)\s*\]|\*+|\b(?:h|l|hh|ll|high|low|abn|abnormal|crit|critical)\b)\s*$/i;
/** A number followed by one unit token ("94 mg/dL", "9 cells/uL", "7.2 x10^3/uL"); never a ratio or range ("128/82", "5-10"). */
const NUMBER_UNIT = /^([-+]?(?:\d[\d,]*(?:\.\d+)?|\.\d+))\s*((?:[a-zA-Zµμ%×]|\/[a-zA-Zµμ])\S*)$/;

/**
 * Text with the comparison symbols spelled out, so normalising keeps them ("<5" is "lt 5", not "5"); a plus beside a
 * number too: a grade ("2+", "+2") is not the number 2.
 */
function textKey(s: string): string {
  return normalizeKey(
    s
      .replace(/<=|=<|≤/g, ' le ')
      .replace(/>=|=>|≥/g, ' ge ')
      .replace(/</g, ' lt ')
      .replace(/>/g, ' gt ')
      .replace(/(\d)\s*\+/g, '$1 plus ')
      .replace(/\+\s*(?=\d)/g, ' plus '),
  );
}

/**
 * The unit's key for comparing (never shown): the shared unitKey (src/shared/labvalues.ts), which folds every spelling
 * of one unit this pass used to fold itself (IU/L = U/L, 1 mIU/mL = 1 U/L, kU/L = U/mL, µIU/mL = mIU/L, bpm = /min,
 * mm/hr = mm/h, °C = C, % = percent, cmH20 = cmH2O, cells/uL = /uL, mm3 and cu mm = uL, mcg = ug, K/uL = 10^3/uL...),
 * plus torr = mmHg and an exactly repeated unit ("cells/uL cells/uL"). Kept under its old name for callers.
 */
export function normUnit(u: string): string {
  return unitKey(u) ?? '';
}

/**
 * Tests whose milliequivalents are millimoles (one charge per ion): sodium, potassium, chloride, bicarbonate (CO2),
 * lithium, lactate, and the anion gap made of them. Calcium and magnesium are not (two charges: 1 mmol/L is 2 mEq/L).
 */
const MONOVALENT = /\b(?:sodium|na|potassium|k|chloride|cl|bicarbonate|bicarb|hco3|co2|tco2|carbon dioxide|lithium|li|lactate|lactic|anion gap)\b/;

/**
 * The unit a value is compared in: its key, and mEq/L read as mmol/L for a monovalent ion (the shared table's factor-1
 * mEq rows, plus lithium, lactate, bicarbonate and the anion gap). The shared table's divalent rows (calcium and
 * magnesium, 2 mEq/L = 1 mmol/L) are not applied here: such a pair stays "not compared" (another unit), as decided
 * (tests/fix-a2-values, fix-a3-values, fix-a4-rules), and so is the pressure row (mmHg against cmH2O).
 */
function unitFor(unit: string, analyte: string): string {
  const u = normUnit(unit);
  if (u !== 'meq/l' || !analyte) return u;
  const name = normalizeKey(analyte);
  if (/\b(?:calcium|magnesium|ca|mg|phosph|zinc|copper|iron)\b/.test(name)) return u;
  return MONOVALENT.test(name) || MONOVALENT.test(normalizeAnalyte(analyte, null)) ? 'mmol/l' : u;
}

function stripFlags(s: string): string {
  let t = s.trim();
  for (let i = 0; i < 3; i++) {
    const next = t.replace(FLAG_TAIL, '').trim();
    if (!next || next === t) break;
    t = next;
  }
  return t;
}

const EMPTY_VALUE: Value = { empty: true, num: null, qual: '', text: '', unit: '', display: '' };

/** A unit written at the end of a result in words or of a ratio ("128/82 mmHg", "1:160 titer"). */
const TRAILING_UNIT = /\s+((?:[a-zA-Zµμ%]|\/[a-zA-Zµμ])[^\s\d]*)$/;
/** What is left in front of such a unit when it is a number, a ratio, a range or a titre ("128/82", "1:160", "5-10"). */
const NUMBER_SHAPED = /^(?:<=|>=|=<|=>|[<>≤≥~])?\s*[-+]?\d[\d,]*(?:\.\d+)?(?:\s*[/:x×–—-]\s*\d[\d,]*(?:\.\d+)?)*$/i;

/** A number as the vital-sign reading writes it ("72", "-2", "1,200", ".5"); null for anything else. */
function plainNumber(s: string): number | null {
  const t = s.trim().replace(/,/g, '');
  if (!/^[-+]?\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const SPELLED_SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const SPELLED_TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/**
 * A whole number written out in words ("twenty-five", "one hundred and five"), read exactly; null for any other words
 * ("Negative", "2+", "trace", "None"). Words are never read as a number otherwise, and the number stored beside them
 * (value_num) is never used for them.
 */
function spelledNumber(text: string | null): number | null {
  const words = (text ?? '').toLowerCase().replace(/[-‐‑–]/g, ' ').replace(/\band\b/g, ' ').trim().split(/\s+/);
  if (!words[0]) return null;
  let total = 0;
  let current = 0;
  let tens = false;
  let units = false;
  for (const w of words) {
    if (w in SPELLED_SMALL) {
      if (units || (tens && SPELLED_SMALL[w] >= 10)) return null;
      current += SPELLED_SMALL[w];
      units = true;
    } else if (w in SPELLED_TENS) {
      if (tens || units) return null;
      current += SPELLED_TENS[w];
      tens = true;
    } else if (w === 'hundred') {
      if (!(tens || units) || current >= 100) return null;
      current *= 100;
      tens = units = false;
    } else if (w === 'thousand') {
      if (!(tens || units || current) || total) return null;
      total = current * 1000;
      current = 0;
      tens = units = false;
    } else return null;
  }
  return total + current;
}

/** A value's number as relate compares it: the number, its qualifier, the number as written, its decimals, a unit printed after it. */
interface ReadNumber {
  num: number | null;
  qual: string;
  dec: number | null;
  unitInValue: string | null;
}

function numberOnRecord(vnum: number | null): ReadNumber {
  return { num: vnum, qual: '', dec: vnum == null ? null : decimalsIn(String(vnum)), unitInValue: null };
}

/**
 * A lab result's number, read by the shared parser (parseLabValue): a measurement ("62", "0.80", "97 H", "94 mg/dL",
 * "3.4E5") or a limit ("<3", "≤0.02", "> OR = 60", "less than 5": its sign becomes the qualifier, its bound the
 * number). A unit printed in the value is the unit when none is stated. A value printed in words, a titre or a range
 * has no number (only a whole number written out in words, "twenty-five", is read as one); the number stored beside it
 * (value_num) is never used then: only a value with no text at all on record is read from value_num.
 */
function labNumber(raw: string, vnum: number | null): ReadNumber {
  if (!raw) return numberOnRecord(vnum);
  const p = parseLabValue(raw);
  if (p.kind === 'number' || p.kind === 'censored') {
    const num = p.kind === 'number' ? p.number : p.bound;
    if (num != null) {
      const written = p.numberText ?? fmtNum(num);
      return { num, qual: p.comparator ? QUALIFIER_OF[p.comparator] : '', dec: p.scientific ? null : decimalsIn(written), unitInValue: p.unitInValue };
    }
  }
  if (p.kind === 'text') {
    const n = spelledNumber(p.text);
    if (n != null) return { num: n, qual: '', dec: 0, unitInValue: null };
  }
  return { num: null, qual: '', dec: null, unitInValue: null };
}

/** A vital sign's number: its qualifier, the number with any flag after it taken off, or a number followed by its unit. */
function vitalNumber(raw: string, vnum: number | null): ReadNumber {
  if (!raw) return numberOnRecord(vnum);
  let num: number | null = null;
  let qual = '';
  let written = '';
  let unitInValue: string | null = null;
  const q = raw.match(QUALIFIER_PREFIX);
  if (q) qual = QUALIFIER_WORD[q[1].toLowerCase()] ?? '';
  const rest = stripFlags(q ? raw.slice(q[0].length) : raw);
  num = plainNumber(rest);
  if (num != null) written = rest;
  if (num == null) {
    // "72 bpm": a number followed by its unit.
    const m = rest.match(NUMBER_UNIT);
    if (m) {
      num = plainNumber(m[1]);
      if (num != null) written = m[1];
      unitInValue = stripFlags(m[2]);
    }
  }
  // Written in a way that does not parse: the number stored beside it, unless the text holds several numbers (a ratio
  // or a range, "128/82", "5-10") that one stored number cannot stand for.
  if (num == null && !qual && (rest.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).length <= 1) {
    num = vnum;
    if (num != null) written = String(num);
  }
  return { num, qual, dec: num == null ? null : decimalsIn(written), unitInValue };
}

function valueOf(type: string, a: Record<string, unknown>): Value {
  if (type === 'procedure' || type === 'event') return EMPTY_VALUE;
  if (type === 'imaging_result') {
    const text = str(a.impression) || str(a.finding);
    return { empty: !text, num: null, qual: '', text: textKey(text), unit: '', display: text ? `"${clip(text, 70)}"` : '', words: text, wording: wordingOf(text) };
  }
  const lab = type === 'lab_result';
  const analyte = lab ? str(a.analyte) : '';
  // lab_result, vital
  const raw = typeof a.value === 'string' ? a.value.trim() : lab && typeof a.value === 'number' && Number.isFinite(a.value) ? String(a.value) : '';
  const vnum = finite(a.value_num);
  let unit = str(a.unit);
  const read = lab ? labNumber(raw, vnum) : vitalNumber(raw, vnum);
  const { num, qual } = read;
  if (!unit && read.unitInValue) unit = read.unitInValue;
  const shown = raw || (vnum != null ? String(vnum) : '');
  let text = textKey(shown);
  let answer: Answer | null = null;
  let ratio = false;
  if (num == null && shown) {
    // A result in words, a ratio or a titre is compared without its flag ("POSITIVE (A)") and without a unit written
    // after it ("128/82 mmHg"): the stated unit, or (none stated) a unit after a number, which then is the unit.
    let t = stripFlags(shown);
    const u = t.match(TRAILING_UNIT);
    if (u && u.index !== undefined) {
      const head = t.slice(0, u.index).trim();
      const stated = Boolean(unit) && normUnit(u[1]) === normUnit(unit);
      if (head && (stated || (!unit && NUMBER_SHAPED.test(head)))) {
        t = head;
        if (!unit) unit = u[1];
      }
    }
    ratio = NUMBER_SHAPED.test(t.trim());
    text = foldAnswer(textKey(t));
    answer = ANSWERS[text] ?? null;
  }
  // The unit as the Labs page shows it: an exactly repeated unit once ("cells/uL cells/uL" is "cells/uL"; rule 5).
  const unitWords = lab ? (parseUnit(unit).unit ?? '') : unit.replace(/\s+/g, ' ').trim();
  const display = shown ? (unitWords && !shown.toLowerCase().includes(unitWords.toLowerCase()) ? `${shown} ${unitWords}` : shown) : '';
  const line = lab && raw ? readLabLine({ analyte, valueText: raw, specimen: str(a.specimen) || defaultSpecimenFor(analyte), specimenStated: Boolean(str(a.specimen)) }) : null;
  const several = Boolean(line && (line.parts || line.combined));
  return { empty: !shown, num, qual, text, unit: unitFor(unit, analyte), unitShown: unitWords, display, dec: num == null ? null : read.dec, answer, ratio, ...(several ? { several } : {}) };
}

/** A result written in words: the common spellings of one answer read as one ("neg", "Negative", "not detected"). */
const TEXT_RESULT: Record<string, string> = {
  neg: 'negative', negative: 'negative', 'not detected': 'negative', 'none detected': 'negative', 'not detectable': 'negative', undetectable: 'negative', absent: 'negative',
  'non reactive': 'nonreactive', nonreactive: 'nonreactive', 'not reactive': 'nonreactive',
  pos: 'positive', positive: 'positive', detected: 'positive', present: 'positive', reactive: 'reactive',
  normal: 'normal', wnl: 'normal', 'within normal limits': 'normal', abnormal: 'abnormal',
};

/**
 * The known answers and how they compare: negative and non-reactive are one side, positive and reactive the other;
 * normal and abnormal are their own pair. Answers of different pairs ("Negative", "Normal") are not compared.
 */
const ANSWERS: Record<string, Answer> = {
  negative: { family: 'np', side: 'negative' },
  nonreactive: { family: 'np', side: 'negative' },
  positive: { family: 'np', side: 'positive' },
  reactive: { family: 'np', side: 'positive' },
  normal: { family: 'na', side: 'normal' },
  abnormal: { family: 'na', side: 'abnormal' },
};

/**
 * Other words for a known answer: "No growth at 72 hours", "No organisms seen", "None seen", "No acid-fast bacilli
 * identified" and "Absent" read negative; "Within normal limits" and "WNL" read normal. Any other wording stays as
 * written (and is compared only when it is written the same).
 */
function foldAnswer(text: string): string {
  const direct = TEXT_RESULT[text];
  if (direct) return direct;
  if (/^(?:no growth|no organisms|none seen|absent)\b/.test(text) || /^no\b.*\b(?:detected|seen|identified)$/.test(text)) return 'negative';
  if (/^(?:within normal limits|wnl)\b/.test(text)) return 'normal';
  return text;
}

/** Digits after the decimal point in a number as written. */
function decimalsIn(s: string): number {
  const m = s.replace(/,/g, '').match(/\.(\d+)/);
  return m ? m[1].length : 0;
}

/** Significant figures of a number written with `dec` decimals ("1.1" -> 2, "62" -> 2, "5" -> 1, "0.5" -> 1). */
function sigFigs(num: number, dec: number): number {
  const whole = Math.trunc(Math.abs(num));
  if (whole > 0) return String(whole).length + dec;
  const frac = Math.abs(num).toFixed(dec).split('.')[1] ?? '';
  return frac.replace(/^0+/, '').length;
}

/**
 * The same number, one written more roughly: rounded to the rougher one's decimals they are equal ("1.08" and
 * "1.1"; "62.4" and "62"). Only when the rougher one keeps two significant figures: "1" and "1.4" differ.
 */
function roundedEqual(a: Value, b: Value): boolean {
  if (a.num == null || b.num == null || a.dec == null || b.dec == null || a.dec === b.dec) return false;
  const [rough, fine] = a.dec < b.dec ? [a, b] : [b, a];
  if (sigFigs(rough.num!, rough.dec!) < 2) return false;
  const f = 10 ** rough.dec!;
  return Math.round(fine.num! * f) === Math.round(rough.num! * f);
}

function unitsCompatible(a: Value, b: Value): boolean {
  return !a.unit || !b.unit || a.unit === b.unit;
}

function numbersEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * A number in unit `from` (a unit key) read in unit `to`, by the shared conversions (convertValue, src/shared/labvalues.ts)
 * that hold whatever the test is: a mass per volume (g, mg, ug, ng, pg per L, dL, mL or uL), a count per volume (/uL =
 * cells/uL; 10^3/uL = K/uL = 10^9/L; 10^6/uL = M/uL = 10^12/L...), a column of water (1 cmH2O = 10 mmH2O). Null for any
 * other pair: mmol/L and mg/dL, mEq/L and mmol/L for calcium or magnesium, mmHg and cmH2O are never converted here (no
 * analyte is passed, so the shared table's per-test rows never apply). Both originals stay as written; this is only for
 * comparing.
 */
function convertNumber(n: number, from: string, to: string): { value: number; factor: number } | null {
  if (!from || !to) return null;
  const c = convertValue(n, from, to, null);
  return c ? { value: c.value, factor: c.factor } : null;
}

/** Unit keys every scaling unit converts into (one per dimension): a unit that converts into one of them scales. */
const SCALE_BASES = ['g/l', '/ul', 'mmh2o'];

/** A unit key that scales whatever the test is (a mass or a count per volume, a column of water). */
function scales(unit: string): boolean {
  return Boolean(unit) && SCALE_BASES.some((b) => convertNumber(1, unit, b) !== null);
}

/**
 * The same unit, however it is written ("K/uL" = "x10^3/uL" = "10^9/L"; "cells/uL" = "/uL"). Not a unit that only
 * converts: "g/dL" is not "mg/dL" (a blood total protein is never read as a CSF protein because of it).
 */
function sameUnit(a: string, b: string): boolean {
  if (a === b) return true;
  const c = convertNumber(1, a, b);
  return Boolean(c && numbersEqual(c.factor, 1));
}

/** What a value in unit b is multiplied by to be in unit a; null when the two do not scale into each other. */
function unitFactor(a: string, b: string): number | null {
  if (!a || !b || (a === b && !scales(a))) return null;
  return convertNumber(1, b, a)?.factor ?? null;
}

/** b's number in a's unit: the same unit (however spelled), or converted when the units scale; null otherwise. */
function numberIn(b: Value, a: Value): number | null {
  if (b.num == null) return null;
  if (unitsCompatible(a, b)) return b.num;
  return convertNumber(b.num, b.unit, a.unit)?.value ?? null;
}

/**
 * Two numbers in units that scale into each other ("0.62 g/L" and "62 mg/dL"): equal once converted, or equal when
 * both are rounded to the rougher one's significant figures (at least two).
 */
function scaledEqual(a: Value, b: Value): boolean {
  if (a.num == null || b.num == null) return false;
  const c = convertNumber(b.num, b.unit, a.unit);
  if (!c) return false;
  const vb = c.value;
  if (numbersEqual(a.num, vb)) return true;
  const n = Math.min(21, Math.max(2, Math.min(sigFigs(a.num, a.dec ?? 0), sigFigs(b.num, b.dec ?? 0))));
  return numbersEqual(Number(a.num.toPrecision(n)), Number(vb.toPrecision(n)));
}

/**
 * Units the app knows (a mass or a count per volume, a column of water, moles, equivalents, mmHg, kPa, units per litre,
 * beats per minute, degrees, percent, kilograms, pounds): two of them that neither match nor scale into each other are
 * known to differ, so an equal number in them is a coincidence ("2.0 mEq/L" of magnesium is 1.0 mmol/L; "32 cmH2O" is
 * not "32 mmHg"; "37 °C" is not "37 °F"). A unit the app does not know may be a spelling of the other one.
 */
const KNOWN_UNITS = new Set(['mmhg', 'kpa', '/min', 'c', 'f', '%', 'u/l', 'u/ml', 'mu/l', 'mu/ml', 'ku/l', 'kg', 'lb', 'lbs', 'mosm/kg', 'mosm/l', 'fl', 'mm/h', 'mm/hr']);

function knownUnit(u: string): boolean {
  return Boolean(u) && (KNOWN_UNITS.has(u) || scales(u) || /^[munpf]?mol\/(?:l|dl|ml)$/.test(u) || /^[mu]?eq\/l$/.test(u));
}

/** Two values whose stated units neither match nor scale into each other (mmol/L and mg/dL): never compared. */
function otherUnits(a: Value, b: Value): boolean {
  return Boolean(a.unit && b.unit) && !unitsCompatible(a, b) && unitFactor(a.unit, b.unit) === null;
}

/** Is x inside the limit `qual bound` ("<3" holds 2, not 3; "≤3" holds 3; ">1700" holds 1800)? Equality within 1e-9. */
function withinLimit(x: number, qual: string, bound: number): boolean {
  const eq = numbersEqual(x, bound);
  switch (qual) {
    case 'lt':
      return x < bound && !eq;
    case 'le':
      return x < bound || eq;
    case 'gt':
      return x > bound && !eq;
    case 'ge':
      return x > bound || eq;
    default:
      return eq;
  }
}

const UPPER = new Set(['lt', 'le']);

/**
 * Two limits that cannot both hold ("<5" and ">5"; "≤3" and ">3"; "<3" and ">5"): an upper limit below a lower one.
 * Two upper (or two lower) limits always overlap ("<3" and "<5" may both be true), and so do "≤5" and "≥5".
 */
function disjointLimits(qa: string, na: number, qb: string, nb: number): boolean {
  if (UPPER.has(qa) === UPPER.has(qb)) return false;
  const [uq, un, lq, ln] = UPPER.has(qa) ? [qa, na, qb, nb] : [qb, nb, qa, na];
  if (numbersEqual(un, ln)) return !(uq === 'le' && lq === 'ge');
  return un < ln;
}

/**
 * The mention gives only a limit and the record a measurement inside it ("<3" against the lab report's 2): not
 * compared (relate 'unknown'). `a` the mention, `b` the record.
 */
function limitAgainstMeasurement(a: Value, b: Value): boolean {
  if (a.num == null || b.num == null || !a.qual || b.qual) return false;
  const bn = numberIn(b, a);
  return bn != null && withinLimit(bn, a.qual, a.num);
}

/**
 * The record gives only a limit and the mention a measurement inside it (the lab report's "<3" against 2): a
 * measurement the record does not contain (relate 'different'). `a` the mention, `b` the record.
 */
function measurementInsideLimit(a: Value, b: Value): boolean {
  if (a.num == null || b.num == null || a.qual || !b.qual) return false;
  const an = numberIn(a, b);
  return an != null && withinLimit(an, b.qual, b.num);
}

/**
 * Two numbers of which at least one is a limit ("<3", ">1700"), `bn` b's number in a's unit. `a` the detail being
 * checked (a mention), `b` the record:
 * - two limits: the same sign and bound are the same; two that cannot both hold ("<5", ">5") differ; any other pair
 *   is not compared ("<3" and "<5", "<5" and "≤5");
 * - the record gives a limit and the mention a measurement: it differs, inside the limit too (the record does not
 *   contain that measurement: "<3" against 2) or outside it ("<3" against 3);
 * - the mention gives a limit and the record a measurement: inside the limit it is not compared ("<3" against the
 *   record's 2: a limit is not a measurement); outside it differs ("<3" against 3, ">1700" against 1200).
 */
function relateLimits(a: Value, b: Value, bn: number, equal: boolean): Relation {
  if (a.qual && b.qual) {
    if (a.qual === b.qual && equal) return 'same';
    return disjointLimits(a.qual, a.num!, b.qual, bn) ? 'different' : 'unknown';
  }
  if (b.qual) return 'different';
  return withinLimit(bn, a.qual, a.num!) ? 'unknown' : 'different';
}

/**
 * How a value compares with another of the same subject (`a` the detail being checked, `b` the record):
 * - 'same': clearly the same. Nothing to compare counts as the same. Two numbers: the same number with the same
 *   qualifier in the same unit (however it is spelled), written more roughly ("1.1" for "1.08"), or the same amount in
 *   a unit that scales ("0.62 g/L" for "62 mg/dL"); in units that neither match nor scale, only the same number, and
 *   never in two units known to differ (knownUnit). Two limits with the same sign and bound. Words: written the same,
 *   or one known answer ("Negative" = "Non-reactive"). A scan impression: worded nearly identically (sameWording), or
 *   the mention says nothing.
 * - 'different': clearly different (another number in the same or a scaling unit, the other answer, another ratio; a
 *   measurement against a record that gives only a limit; a limit the record's measurement is outside of; two limits
 *   that cannot both hold). Never a scan impression: wording is not judged.
 * - 'unknown': not compared. Units that neither match nor scale (mmol/L and mg/dL, mEq/L and mmol/L for calcium),
 *   wording that is no known answer ("Clear and colorless", "Clear, colorless"), answers of different kinds
 *   ("Negative", "Normal"), a scan impression worded otherwise than the record's (or a record that gives none), a limit
 *   the record's measurement is inside of ("<3" against 2), two limits that may both hold ("<3" and "<5"). What is
 *   not compared is neither accurate nor inaccurate: nothing is set aside for it, it restates nothing, and it
 *   disagrees with nothing.
 */
function relate(type: string, a: Value, b: Value): Relation {
  if (type === 'imaging_result') {
    if (a.empty) return 'same';
    if (b.empty || !a.wording || !b.wording) return 'unknown';
    return sameWording(a.wording, b.wording) ? 'same' : 'unknown';
  }
  if (a.empty || b.empty) return 'same';
  // A line that holds several tests: the same only when it is the same line written the same; otherwise not compared.
  if (a.several || b.several) return a.several && b.several && a.text === b.text && unitsCompatible(a, b) ? 'same' : 'unknown';
  if (a.num != null && b.num != null) {
    if (unitsCompatible(a, b)) {
      const equal = numbersEqual(a.num, b.num) || roundedEqual(a, b);
      if (a.qual || b.qual) return relateLimits(a, b, b.num, equal);
      return equal ? 'same' : 'different';
    }
    // Units that scale into each other: compared once converted ("62 g/L" is not "62 mg/dL").
    if (unitFactor(a.unit, b.unit) != null) {
      const equal = scaledEqual(a, b);
      if (a.qual || b.qual) return relateLimits(a, b, numberIn(b, a)!, equal);
      return equal ? 'same' : 'different';
    }
    // Units known to differ: an equal number is no copy ("2.0 mEq/L" of magnesium is not "2.0 mmol/L").
    if (knownUnit(a.unit) && knownUnit(b.unit)) return 'unknown';
    return a.qual === b.qual && numbersEqual(a.num, b.num) ? 'same' : 'unknown';
  }
  if (!unitsCompatible(a, b)) return 'unknown';
  if (a.text === b.text) return 'same';
  // Two ratios, ranges or titres ("128/82" and "138/90") are compared number by number.
  if (a.ratio && b.ratio) return 'different';
  if (a.answer && b.answer && a.answer.family === b.answer.family) return a.answer.side === b.answer.side ? 'same' : 'different';
  return 'unknown';
}

/** Can two values of one subject be compared at all (relate is not 'unknown')? */
function comparable(type: string, a: Value, b: Value): boolean {
  return relate(type, a, b) !== 'unknown';
}

/** Is `a` clearly the same as `b` (the record)? */
function sameValue(type: string, a: Value, b: Value): boolean {
  return relate(type, a, b) === 'same';
}

/** Two records (or two readings of one day) that are the same either way round (a scan with no impression is the same reading as one with). */
function sameEither(type: string, a: Value, b: Value): boolean {
  return sameValue(type, a, b) || sameValue(type, b, a);
}

/** Are two values clearly different (a disagreement)? Values that cannot be compared never are. */
function differs(type: string, a: Value, b: Value): boolean {
  return relate(type, a, b) === 'different';
}

/**
 * Two values of which neither is the record (two clinical records that may contest, two mentions with no record):
 * clearly different whichever is read first. A limit and a measurement inside it ("<3" and 2) do not disagree then:
 * both can be true. Values without a limit compare the same either way round.
 */
function differsEitherWay(type: string, a: Value, b: Value): boolean {
  if (!a.qual && !b.qual) return differs(type, a, b);
  return differs(type, a, b) && differs(type, b, a);
}

/** Why two values were not compared, in plain words. */
function notComparedWhy(type: string, a: Value, b: Value): string {
  if (type === 'imaging_result') return 'other words';
  // Limits in the same unit or in units that convert: not compared for what they say, not for their unit.
  if (limitAgainstMeasurement(a, b) || limitAgainstMeasurement(b, a)) return 'a limit, not a measurement';
  if (a.num != null && b.num != null && a.qual && b.qual && numberIn(b, a) != null) return 'another limit';
  if (a.unit && b.unit && a.unit !== b.unit && !sameUnit(a.unit, b.unit)) return a.num != null && b.num != null ? 'another unit' : 'another unit or other words';
  return 'other words';
}

/**
 * "Not compared: the lab report gives CSF glucose 112 mg/dL on 2024-03-18 (another unit)." A value that gives only a
 * limit against a record's measurement inside it says so first: "Not compared: this gives only a limit (<3 cells/uL),
 * not a measurement, and the lab report gives CSF RBC 2 cells/uL on 2024-03-18."
 */
function notComparedWithRecords(type: string, v: Value, ps: MFact[], m?: Pick<Match, 'resulted'> | null): string {
  const gives = `${givesWords(ps)}${resultedWords(ps[0], m)}`;
  if (type === 'lab_result' && limitAgainstMeasurement(v, ps[0].value)) return `Not compared: this gives only a limit (${v.display}), not a measurement, and ${gives}.`;
  return `Not compared: ${gives} (${notComparedWhy(type, v, ps[0].value)}).`;
}

/** A key that is equal for two values sameValue reads as equal (imaging, rounding and other units aside). */
function valueKey(v: Value): string {
  if (v.empty) return '';
  if (v.num != null) return `${v.qual}${v.num}`;
  return v.answer ? `${v.answer.family}:${v.answer.side}` : v.text;
}

// ---------------------------------------------------------------------------
// Scan impressions
// ---------------------------------------------------------------------------

/**
 * Scan impressions are not read for their findings. Radiology wording (negation, hedges, advice sentences, spinal
 * levels, words of change) kept being read wrongly both ways, so two impressions are the same only when they are
 * worded nearly identically, and otherwise not compared: both are shown, for the user (and the clinician) to read.
 */
interface Wording {
  /** Every word, normalised: lower case, no punctuation, no list numbers ("1."), "T7-8" as "t7 t8", "6 mm" as "6mm". */
  tokens: string[];
  /** The words that carry what the impression says, in order (little words such as "the", "is", "of", "seen" left out). */
  content: string;
  /** Negation, hedge, change and side words, numbers and spinal levels: each kind as a sorted set. */
  guard: string;
}

/** Little words that say nothing about what a scan showed (and section labels). Never a word of negation, hedging, change or side. */
const LITTLE_WORDS = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'there', 'this', 'that', 'these', 'those', 'it', 'its', 'which', 'has', 'have', 'had', 'of', 'on', 'in', 'at', 'to', 'with', 'and', 'as', 'by', 'for', 'from', 'also', 'seen', 'noted', 'identified', 'demonstrated', 'present', 'evidence', 'impression', 'findings', 'conclusion']);
/** Words that deny ("no", "without", "negative for", "resolved", "unlikely"...). A word starting with "non" counts too. */
const NEGATION_WORDS = new Set(['no', 'not', 'without', 'negative', 'free', 'resolved', 'resolution', 'absent', 'absence', 'unlikely', 'none', 'neither', 'nor', 'never', 'lack', 'lacks', 'lacking', 'excluded', 'exclude', 'ruled']);
/** Words that make a finding only a possibility ("possible", "cannot be excluded", "suspicious for", "mimicking", "?"). */
const HEDGE_WORDS = new Set([
  'possible', 'possibly', 'probable', 'probably', 'likely', 'unlikely', 'likelihood', 'less', 'suspicious', 'suspected', 'suspect', 'suspicion', 'mimicking', 'mimic', 'mimics',
  'mimicked', 'simulating', 'resembling', 'questionable', 'equivocal', 'indeterminate', 'concerning', 'worrisome', 'may', 'might', 'could', 'can', 'perhaps', 'versus', 'vs',
  'differential', 'consider', 'considered', 'favor', 'favored', 'favour', 'favoured', 'doubtful', 'improbable', 'suggest', 'suggests', 'suggestive', 'suggesting',
  'suggested', 'excluded', 'exclude', 'uncertain', 'query', 'probability', 'possibility', 'presumed', 'presumably', 'apparent', 'apparently', 'consistent', 'compatible',
]);
/** Words that say something changed, or did not ("new", "stable", "improved", "enlarging", "interval", "resolved"). */
const CHANGE_WORDS = new Set([
  'new', 'newly', 'stable', 'stability', 'stabilized', 'stabilised', 'unchanged', 'change', 'changes', 'changed', 'improved', 'improving', 'improvement', 'better', 'worse',
  'worsening', 'worsened', 'increased', 'increasing', 'increase', 'decreased', 'decreasing', 'decrease', 'enlarging', 'enlarged', 'enlargement', 'resolved', 'resolving',
  'resolution', 'interval', 'progression', 'progressive', 'progressed', 'progressing', 'regression', 'regressed', 'regressing', 'persistent', 'persisting', 'persists',
  'persist', 'persistence', 'residual', 'again', 'redemonstrated', 'previously', 'previous', 'prior', 'since', 'recurrent', 'recurrence', 'recurred', 'smaller', 'larger',
  'reduced', 'reduction', 'diminished', 'partial', 'partially', 'complete', 'completely', 'nearcomplete', 'developing', 'development', 'evolving', 'evolution', 'more', 'less',
]);
/** Which side: left, right, bilateral (and "right-sided", "leftward"...), both, midline. */
const SIDE_WORD = /^(?:left|right|bilateral|unilateral|ipsilateral|contralateral|both|midline)/;
/** A spinal level as normalised ("t7"). */
const LEVEL_TOKEN = /^[ctls]\d{1,2}$/;
/** Comparison signs and plus / minus, spelled out by wordingOf ("<" lt, "≤" le, ">" gt, "≥" ge, "(+)" plus, "(-)" minus, "±" plusminus). */
const SIGN_WORDS = new Set(['lt', 'le', 'gt', 'ge', 'plus', 'minus', 'plusminus', 'arrowup', 'arrowdown']);

/**
 * An impression's words for comparing: lower case; "can't" / "cannot" as "can not"; list numbers ("1.", "2)") left out
 * (after a colon only the "1." that starts a list: "diameter: 5." keeps its number); spinal levels one per vertebra
 * ("T7-8", "T7-T8" and "T7 to T8" are "t7 t8"; "L5/S1" is "l5 s1"); comparison signs and plus / minus spelled out as
 * words ("<=" and "≤" le, ">=" and "≥" ge, "<" lt, ">" gt, "+" and "(+)" plus, a "-" or "(-)" standing alone or before
 * a number minus, "±" plusminus), so ">5 mm" is not "<5 mm" and "(+)" is not "(-)"; a number and its unit as one word
 * ("6 mm" is "6mm"); hyphenated words joined ("non-enhancing" is "nonenhancing"); "?" as "query".
 */
function wordingOf(text: string): Wording {
  // A number written without its leading zero (".5 cm") is 0.5, never 5.
  const lower = ` ${text.toLowerCase().normalize('NFKC')} `.replace(/[‐-―−]/g, '-').replace(/(^|[^\d])\.(\d)/g, (_m, a: string, b: string) => `${a}0.${b}`);
  // A numbered list has a "1." item and a "2." item: then every item number is left out. Without one, only a "1." at
  // the start, after a colon or on a new line is (a lone list marker): "lesions:\n2. Stable." keeps its 2.
  const item = (k: string) => new RegExp(String.raw`(?:^\s*|[.;:\n]\s*)\(?${k}[.)]\s+[a-z]`).test(lower);
  const list = item('1') && item('2');
  let t = lower.replace(/\bcan(?:'|’)?t\b|\bcannot\b/g, ' can not ').replace(/n(?:'|’)t\b/g, ' not');
  t = list ? t.replace(/(^\s*|[.;:\n]\s*)\(?\d{1,2}[.)]\s+(?=[a-z])/g, '$1 ') : t.replace(/(^\s*|[:\n]\s*)\(?1[.)]\s+(?=[a-z])/g, '$1 ');
  t = t
    .replace(/\b([ctls])\s?(\d{1,2})\s*(?:-|\/|\bto\b|\bthrough\b)\s*([ctls])?\s?(\d{1,2})\b/g, (_m, a: string, n: string, b: string | undefined, k: string) => ` ${a}${n} ${b ?? a}${k} `)
    .replace(/\b([ctls])\s?(\d{1,2})\b/g, ' $1$2 ')
    // Comparison signs and plus / minus are words that must match exactly. A range written with spaces ("5 - 10") stays
    // a range; a hyphen joining words, or a dash before words (a bullet, an aside), is not a minus.
    .replace(/<=|=<|≤|⩽|≦/g, ' le ')
    .replace(/>=|=>|≥|⩾|≧/g, ' ge ')
    .replace(/↑|⬆/g, ' arrowup ')
    .replace(/↓|⬇/g, ' arrowdown ')
    .replace(/</g, ' lt ')
    .replace(/>/g, ' gt ')
    .replace(/±|∓|\+\s*\/\s*-|-\s*\/\s*\+/g, ' plusminus ')
    .replace(/\(\s*\+\s*\)/g, ' plus ')
    .replace(/\(\s*-\s*\)/g, ' minus ')
    .replace(/\+/g, ' plus ')
    .replace(/(\d)\s*-\s*(?=\d)/g, '$1-')
    .replace(/(^|[^a-z0-9])-ve\b/g, '$1 minus ve')
    .replace(/(^|[\s(:=])-(?=\d)/g, '$1 minus ')
    .replace(/(^|[\s(:=,;])-+(?=[ \t]*(?:[).,;:\n]|$))/g, '$1 minus ')
    .replace(/(\d)\s+(mm|cm|ml|cc|hu|mmhg|cmh2o|%)(?![a-z0-9])/g, '$1$2')
    .replace(/([a-z])-(?=[a-z])/g, '$1')
    .replace(/\?/g, ' query ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/[^a-z0-9.%]+/g, ' ');
  const tokens = t.split(' ').filter(Boolean);
  const kinds: Array<(w: string) => boolean> = [
    (w) => NEGATION_WORDS.has(w) || (w.startsWith('non') && w.length > 5),
    (w) => HEDGE_WORDS.has(w),
    (w) => CHANGE_WORDS.has(w),
    (w) => SIDE_WORD.test(w),
    (w) => /^\d/.test(w),
    (w) => LEVEL_TOKEN.test(w),
    (w) => SIGN_WORDS.has(w),
  ];
  const guard = kinds.map((is) => [...new Set(tokens.filter(is))].sort().join(' ')).join('|');
  return { tokens, content: tokens.filter((w) => !LITTLE_WORDS.has(w)).join(' '), guard };
}

/**
 * Two impressions worded nearly identically: the same words once case, punctuation, spacing and list numbers are set
 * aside, or (token Jaccard 0.9 or more) the same words of negation, hedging, change and side, the same numbers, spinal
 * levels and comparison or plus / minus signs, and the same words that carry the finding in the same order (only little
 * words such as "the" or "is" may differ). "Mild" for "severe", "ventral" for "dorsal", left and right swapped, ">5 mm"
 * for "<5 mm" or "(+)" for "(-)" is never the same.
 */
function sameWording(a: Wording, b: Wording): boolean {
  if (a.tokens.join(' ') === b.tokens.join(' ')) return true;
  if (a.guard !== b.guard || a.content !== b.content) return false;
  const x = new Set(a.tokens);
  const y = new Set(b.tokens);
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  const union = x.size + y.size - both;
  return union > 0 && both / union >= 0.9;
}

const isDay = (iso: string | null): iso is string => Boolean(iso && iso.length === 10);
const isCoarse = (iso: string | null): iso is string => Boolean(iso && (iso.length === 7 || iso.length === 4));

/** Days a mention may be from a verified detail and still be read as the same event: a repeated treatment (an infusion, a plasma exchange, a therapy session) only on its own day. */
function windowFor(type: string, a: Record<string, unknown>): number {
  if ((type === 'procedure' || type === 'event') && isRepeatedTreatment(str(a.name))) return 0;
  return NEAR_DAYS[type as ReconcileType] ?? 0;
}

/** Specimens a lab result that does not say its specimen may be about. */
const KNOWN_SPECIMENS = ['csf', 'serum', 'plasma', 'whole_blood', 'urine'];

/** The subject keys an analyte has under each specimen (and unknown), for a lab result that does not say its specimen. */
function labKeysFor(analyte: string): string[] {
  const out = new Set<string>();
  for (const s of [null, ...KNOWN_SPECIMENS]) {
    const k = normalizeAnalyte(analyte, s);
    if (k) out.add(`lab|${k}|${specimenBucket(s, analyte)}`);
  }
  return [...out];
}

/**
 * A procedure or event named as one occasion among several ("Repeat LP", "Second lumbar puncture", "2nd ER visit",
 * "LP #2", "Lumbar puncture no. 3"): its name folds into the first one's, so it is compared on its own date only and
 * never read as a wrong date of the first. "#1", "no. 1" and "first" name the first one: not a repeat.
 */
const OCCASION_WORDS = /\b(?:repeat|repeated|second|2nd|third|3rd|fourth|4th|fifth|5th|redo|re-do)\b|#\s*(?:[2-9]|[1-9]\d)\b|\b(?:no\.?|number)\s*(?:[2-9]|[1-9]\d)\b/;

/**
 * A lab result's resulted (reported) date as its document prints it (attributes.resulted_date, written as printed),
 * read to a full day, when it is not the fact's own date; null when none is printed, it gives no full day, or it is
 * the fact's date. Nothing is inferred from page text.
 */
function resultedDayOf(written: unknown, factDate: string | null): string | null {
  const t = str(written);
  if (!t) return null;
  const d = parsePartialDate(t);
  return d.precision === 'day' && d.iso && d.iso !== factDate ? d.iso : null;
}

/** Compared on its own date only: the user said "not the same event", its document gives the subject on another day close by, or its name says it is a repeat. */
function exactOnly(f: MFact): boolean {
  return f.separate || f.multi;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function loadFacts(): MFact[] {
  const f = schema.facts;
  const doc = schema.documents;
  // Whether passages of an export are sources of their own (read once for the whole load).
  const byPassage = passageSourceUnitsOn();
  const out: MFact[] = db()
    .select({
      id: f.id,
      type: f.type,
      statement: f.statement,
      date: f.date,
      datePrecision: f.datePrecision,
      dateText: f.dateText,
      attributesJson: f.attributesJson,
      status: f.status,
      verdictBasis: f.verdictBasis,
      verdictNote: f.verdictNote,
      verdictAt: f.verdictAt,
      supersededById: f.supersededById,
      origin: f.origin,
      createdAt: f.createdAt,
      documentId: doc.id,
      documentTitle: doc.title,
      documentCategory: doc.category,
      tier: doc.sourceTier,
      assertedBy: f.assertedBy,
    })
    .from(f)
    .innerJoin(doc, eq(doc.id, f.sourceDocumentId))
    .where(and(inArray(f.type, [...RECONCILED_TYPES]), isNull(f.deletedAt), isNull(doc.deletedAt)))
    .all()
    .map((r) => {
      const a = parseJson<Record<string, unknown>>(r.attributesJson, {});
      // A passage of an export stands for the kind of document it is (its Labs section is the lab's report, its notes
      // are clinic notes), and is a source of its own; trust follows the passage (the patient's words are his).
      const segmentId = byPassage ? segmentIdOf(a) : null;
      const passageCategory = segmentId ? categoryForSegmentKind(segmentKindOf(a)) : null;
      const subject = subjectOf(r.type, a);
      const analyte = r.type === 'lab_result' ? str(a.analyte) : '';
      const correctionNote = typeof a._correctionNote === 'string' ? a._correctionNote : null;
      return {
        id: r.id,
        type: r.type as ReconcileType,
        statement: r.statement,
        date: r.date,
        datePrecision: r.datePrecision,
        dateText: r.dateText,
        status: r.status,
        verdictBasis: r.verdictBasis,
        verdictNote: r.verdictNote,
        verdictAt: r.verdictAt,
        supersededById: r.supersededById,
        origin: r.origin,
        createdAt: r.createdAt,
        documentId: r.documentId,
        documentTitle: r.documentTitle,
        documentCategory: passageCategory ?? r.documentCategory,
        tier: factTier(r.tier, { assertedBy: r.assertedBy, attributes: a }),
        sourceKey: sourceKeyOf({ documentId: r.documentId, segmentId, orderKey: segmentId ? epicOrderKey({ type: r.type, statement: r.statement, attributes: a }) : null }, byPassage),
        userEdited: a._userEdited === true,
        separate: a[SEPARATE_MARKER] === true,
        // "Repeat LP", "Second lumbar puncture", "LP #2": an occasion of its own, compared on its own date only.
        multi: (r.type === 'procedure' || r.type === 'event') && OCCASION_WORDS.test(str(a.name).toLowerCase()),
        key: subject.key,
        label: subject.label,
        value: valueOf(r.type, a),
        window: windowFor(r.type, a),
        resultedDay: r.type === 'lab_result' ? resultedDayOf(a.resulted_date, r.date) : null,
        unknownSpecimenAnalyte: analyte && subject.key?.endsWith('|unknown') ? analyte : null,
        sampleKeys: null,
        // The note a correction wrote (its reason, then any earlier note): the reason alone is what explains it.
        reasonNote: correctionNote !== null && r.verdictNote === correctionNote && typeof a._correctionReason === 'string' ? a._correctionReason : r.verdictNote,
      };
    });
  // A lab mention that does not say its specimen ("protein 62") meets the clinical record of that test on its own
  // day when every record of it that day has one specimen (CSF, serum...); with records of two specimens that day
  // it is not compared, naming them (sampleKeys); with none it stays apart. A CSF result never meets a serum one when
  // both are known. A test named as a blood test ("Blood glucose", "Fasting glucose", "Blood WBC") never meets a CSF
  // record, and a mention whose unit no
  // record of that test gives that day ("Total protein 6.8 g/dL" against CSF protein in mg/dL) stays apart.
  const recordKeysByDay = new Map<string, Map<string, { label: string; units: Set<string>; unitless: boolean }>>();
  for (const x of out) {
    if (x.type !== 'lab_result' || !x.key || x.tier !== 'primary' || !isDay(x.date) || !recordEligible(x)) continue;
    const keys = recordKeysByDay.get(x.date) ?? new Map<string, { label: string; units: Set<string>; unitless: boolean }>();
    const k = keys.get(x.key) ?? { label: x.label, units: new Set<string>(), unitless: false };
    if (x.value.unit) k.units.add(x.value.unit);
    else k.unitless = true;
    keys.set(x.key, k);
    recordKeysByDay.set(x.date, keys);
  }
  for (const x of out) {
    if (!x.unknownSpecimenAnalyte || x.tier === 'primary' || !isDay(x.date)) continue;
    const keys = recordKeysByDay.get(x.date);
    if (!keys) continue;
    const bloodNamed = BLOOD_NAMED.test(normalizeKey(x.unknownSpecimenAnalyte));
    const found = labKeysFor(x.unknownSpecimenAnalyte).filter((k) => keys.has(k) && !(bloodNamed && k.endsWith('|csf')));
    // Records of several samples that day (CSF glucose 60 and serum glucose 95): which one it is cannot be told.
    if (found.length > 1 && !found.includes(x.key!)) {
      x.sampleKeys = found;
      continue;
    }
    if (found.length !== 1 || found[0] === x.key) continue;
    const rec = keys.get(found[0])!;
    const unit = x.value.unit;
    if (unit && !rec.unitless && rec.units.size && ![...rec.units].some((u) => sameUnit(u, unit))) continue;
    x.key = found[0];
    x.label = rec.label || x.label;
  }
  // A document that gives the same subject on two different days close together describes two occurrences (an
  // infusion course, two lumbar punctures): those mentions are compared on their own dates only.
  const days = new Map<string, Set<string>>();
  for (const x of out) {
    if (!x.key || !isDay(x.date) || !x.window) continue;
    const k = `${x.documentId}\u001f${x.key}`;
    const set = days.get(k);
    if (set) set.add(x.date);
    else days.set(k, new Set([x.date]));
  }
  for (const x of out) {
    if (!x.key || !isDay(x.date) || !x.window) continue;
    const set = days.get(`${x.documentId}\u001f${x.key}`);
    if (!set || set.size < 2) continue;
    const w = x.window;
    const date = x.date;
    for (const other of set) {
      if (other !== date && Math.abs(daysBetween(date, other)) <= w) {
        x.multi = true;
        break;
      }
    }
  }
  return out;
}

/** The user has worked on this fact: an edit, or a note of theirs (which must keep reaching the clinician). */
function hasUserWork(f: MFact): boolean {
  return f.userEdited || Boolean(f.verdictNote && f.verdictNote.trim());
}

/** The patient's own word for this event (correctRecord). */
function isCorrection(f: MFact): boolean {
  return f.status === 'confirmed' && f.verdictBasis === 'correction';
}

/** A fact a clinical record's document may stand on: live, not marked wrong, not "Not sure". */
function recordEligible(f: Pick<MFact, 'status' | 'verdictBasis'>): boolean {
  return (f.status === 'unverified' && f.verdictBasis !== 'unsure') || f.status === 'confirmed';
}

/**
 * Which of several records (of one subject and day, that agree) is named "the record", first: the one the user chose
 * (a correction, or "This one is right" on a clinical record); then the subject's own report (ownReport: the lab
 * report or pathology report for a lab, the scan report for a scan, the operative report for a procedure) before a
 * clinic note or a discharge summary that restates it; within each, a confirmed fact first; then the oldest.
 */
function byPreference(a: MFact, b: MFact): number {
  const rank = (f: MFact) => (isCorrection(f) ? 0 : (ownReport(f) ? 1 : 3) + (f.status === 'confirmed' ? 0 : 1));
  return rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/** Distinct readings among verified facts: one per date and value (duplicate copies of one report collapse). */
function distinctReadings(ps: MFact[]): MFact[] {
  const seen: MFact[] = [];
  for (const p of ps) if (!seen.some((q) => q.date === p.date && sameEither(p.type, q.value, p.value))) seen.push(p);
  return seen;
}

function readings(ps: MFact[]): number {
  return distinctReadings(ps).length;
}

type MergeRow = typeof schema.factMerges.$inferSelect;

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Lab results and vitals: two clinical records are compared on the same day, by value. Others: by date, within the window. */
function comparedByValue(type: string): boolean {
  return type === 'lab_result' || type === 'vital';
}

/**
 * Is this document the subject's own report: the lab report (or pathology report) for a lab result, the scan report
 * for a scan, the operative or procedure report for a procedure? A clinic note or a discharge summary that restates
 * it is a clinical record too, but the report outranks it.
 */
function ownReport(f: Pick<MFact, 'type' | 'documentCategory'>): boolean {
  switch (f.type) {
    case 'lab_result':
      return f.documentCategory === 'lab_report' || f.documentCategory === 'pathology';
    case 'imaging_result':
      return f.documentCategory === 'imaging_report';
    case 'procedure':
      return f.documentCategory === 'operative_report';
    default:
      return false;
  }
}

/**
 * Two clinical records that may contest each other: from different documents of different kinds. Two lab reports,
 * two scan reports or two clinic notes are separate readings or occasions, never a disagreement. The subject's own
 * report outranks a restatement (findRestatements) without asking, except a restatement the user said is accurate:
 * their word against the report is a disagreement for them to settle, never one the app settles quietly either way.
 */
function mayContest(a: MFact, b: MFact): boolean {
  if (a.sourceKey === b.sourceKey || a.documentCategory === b.documentCategory) return false;
  const ra = ownReport(a);
  const rb = ownReport(b);
  if (!ra && !rb) return true;
  if (ra && rb) return false;
  const restatement = ra ? b : a;
  return restatement.status === 'confirmed' && !isCorrection(restatement);
}

/**
 * A clinical record that restates what the subject's own report gives (a clinic note or a discharge summary quoting
 * the lab report, the scan report or the operative report) and says something else: the report is the truth, and
 * the restating record reads inaccurate against it (never changed and never set aside). A lab result on the
 * report's day, by value (the same number written more roughly, or in a unit that converts, is the same; a value
 * that cannot be compared, in a unit that does not convert or in other words, is left alone); a procedure or a scan
 * by date within the window (on the report's own day it is the same occasion). A scan on the scan report's own day
 * worded otherwise than the report (not nearly identical) is not compared (`notCompared`, the report quoted) and is no
 * truth: wording is never judged, so it is neither inaccurate nor a record to match. Never a record the user chose or confirmed, one
 * marked "Both happened" or given beside another day by its own document, or a pair the user declined as duplicates.
 */
function findRestatements(truths: MFact[], userDecided: Set<string>): Map<string, Match> {
  const reports = new Map<string, MFact[]>();
  for (const f of truths) {
    if (f.tier !== 'primary' || !f.key || !isDay(f.date) || !ownReport(f)) continue;
    const list = reports.get(f.key);
    if (list) list.push(f);
    else reports.set(f.key, [f]);
  }
  const out = new Map<string, Match>();
  if (!reports.size) return out;
  for (const r of truths) {
    if (r.tier !== 'primary' || !r.key || !isDay(r.date) || ownReport(r) || isCorrection(r) || r.status === 'confirmed' || r.separate) continue;
    const rDate = r.date;
    const list = (reports.get(r.key) ?? []).filter((p) => p.sourceKey !== r.sourceKey && !userDecided.has(pairKey(r.id, p.id)));
    if (!list.length) continue;
    const sameDay = list.filter((p) => p.date === rDate);
    if (sameDay.length) {
      if (!comparedByValue(r.type)) {
        // A scan on the scan report's own day is the same scan, and its wording is the report's only when worded nearly
        // identically (or it gives none). Otherwise it is not compared (the report quoted) and is no truth: nothing is
        // matched with it or set aside against it (a summary copying a clinic note's wording is compared with the report).
        if (r.type !== 'imaging_result' || sameDay.some((p) => sameValue(r.type, r.value, p.value))) continue;
        const p = [...sameDay].sort(byPreference)[0];
        const others = sameDay.filter((q) => q !== p);
        out.set(r.id, others.length ? { p, same: false, near: false, notCompared: true, others } : { p, same: false, near: false, notCompared: true });
        continue;
      }
      if (sameDay.some((p) => !differs(r.type, r.value, p.value))) continue;
      const p = [...sameDay].sort(byPreference)[0];
      const others = sameDay.filter((q) => q !== p);
      out.set(r.id, others.some((q) => !sameEither(q.type, q.value, p.value)) ? { p, same: false, near: false, others } : { p, same: false, near: false });
      continue;
    }
    // A lab result on another day may be another draw (a clinic visit's own test): only procedures and scans are
    // compared on a near day.
    if (comparedByValue(r.type) || !r.window || exactOnly(r)) continue;
    let best: MFact | null = null;
    let bestDays = Infinity;
    for (const p of list) {
      if (exactOnly(p)) continue;
      const dd = Math.abs(daysBetween(rDate, p.date!));
      if (dd > r.window) continue;
      if (!best || dd < bestDays || (dd === bestDays && (p.date! < best.date! || (p.date === best.date && byPreference(p, best) < 0)))) {
        best = p;
        bestDays = dd;
      }
    }
    if (best) out.set(r.id, { p: best, same: false, near: true });
  }
  return out;
}

/** Clinical records (from different documents) that disagree about one event, and nothing the user said settles it. */
export interface Contest {
  key: string;
  type: ReconcileType;
  /** The earliest record's date. */
  date: string;
  /** The records, by date, then document. */
  records: MFact[];
  documentCount: number;
}

/** The ledger as one pass (or one read) sees it: facts, links, what the user decided, and the truth. */
interface Ledger {
  facts: MFact[];
  byId: Map<string, MFact>;
  linksByS: Map<string, MergeRow[]>;
  /** The accepted link that sets each fact aside right now (the pass's). */
  active: Map<string, MergeRow>;
  /** Pairs the user already decided about as possible duplicates. */
  userDecided: Set<string>;
  /** Verified facts (not outranked by a correction, not in a contest) and the patient's corrections, by subject key. */
  truthByKey: Map<string, MFact[]>;
  truthIds: Set<string>;
  /** A fact the patient's correction outranks (a record's fact, or an older correction) -> that correction. */
  outranked: Map<string, MFact>;
  /**
   * The patient's corrections (on a document that is no clinical record) that outrank no record although a record of
   * that day is there (it agrees, or gives the value in another unit: "This one is right" on 6.2 mmol/L beside the lab
   * report's 112 mg/dL): his choice of the right value, not a correction of the record.
   */
  chosen: Set<string>;
  /**
   * Clinical records that restate the subject's own report and say something else: record id -> the report it is
   * compared with. A scan worded otherwise than the scan report of its day is here too, `notCompared` (not a truth).
   */
  restated: Map<string, Match>;
  /** Clinical records that disagree with each other: record id -> its contest; and the contested records by subject key. */
  contestOf: Map<string, Contest>;
  contestedByKey: Map<string, MFact[]>;
  contests: Contest[];
}

/**
 * What correction c outranks among `pool` (records, or older corrections, of its subject): on its own day, the
 * ones that say something else (one that agrees stays, and so does a record in a unit that neither matches nor
 * converts: it says nothing against the correction; an older correction in another unit does not stay: the later
 * word replaces it); with none that day, those on the nearest day within the window (as findMatch would pick it:
 * neither side compared on its own date only; a tie goes to the same value, then the earlier day). Never a record of
 * another occasion further away. `records`: the pool holds clinical records (not older corrections).
 */
function reachOf(c: MFact, pool: MFact[], userDecided: Set<string>, records: boolean): MFact[] {
  if (!c.key || !isDay(c.date)) return [];
  const cDate = c.date;
  // A clinical record chosen as the right one (This one is right) never outranks its own document's other readings.
  const others = pool.filter((p) => p.id !== c.id && p.key === c.key && isDay(p.date) && !userDecided.has(pairKey(c.id, p.id)) && !(c.tier === 'primary' && p.sourceKey === c.sourceKey));
  const sameDay = others.filter((p) => p.date === cDate);
  // A record in a unit that neither matches nor converts says nothing against the correction ("6.2 mmol/L" chosen
  // beside the lab report's "112 mg/dL"): it keeps its word, and only what can be compared follows the correction. An
  // older correction is the user's own earlier word: a later one replaces it whatever its unit.
  if (sameDay.length) return sameDay.filter((p) => !sameValue(p.type, c.value, p.value) && !(records && otherUnits(c.value, p.value)));
  if (!c.window || exactOnly(c)) return [];
  let bestDate: string | null = null;
  let bestDays = Infinity;
  let bestSame = false;
  for (const p of others) {
    if (exactOnly(p)) continue;
    const dd = Math.abs(daysBetween(cDate, p.date!));
    if (dd > c.window) continue;
    const same = sameValue(p.type, c.value, p.value);
    if (dd < bestDays || (dd === bestDays && ((same && !bestSame) || (same === bestSame && bestDate !== null && p.date! < bestDate)))) {
      bestDate = p.date;
      bestDays = dd;
      bestSame = same;
    }
  }
  return bestDate ? others.filter((p) => p.date === bestDate && !exactOnly(p)) : [];
}

/**
 * Clinical records that disagree with each other, from different live documents of different kinds (mayContest:
 * never two lab reports, two scan reports or two clinic notes, and never the subject's own report, which outranks a
 * restatement), neither marked "Both happened" (separate) nor chosen by the user (a correction): a lab result whose
 * values one document gives that day share none with another's (a document never disagrees with itself; its values
 * that day are a set; the same number written more roughly, in a unit that converts, or a value that cannot be
 * compared, is not a disagreement); a procedure, event or scan whose dates within the window share none with another
 * document's (a document that also gives the other date agrees). Vital signs never: they are taken again and again.
 * A pair the user declined as duplicates is never compared. A record that restates a reading (lab) or a date
 * (procedure) the subject's own report gives is backed by it and contests nothing: a clinic note quoting one lab
 * report and a discharge summary quoting another are two real readings. Only the records of the pairs that disagree
 * are in the contest.
 */
function findContests(truths: MFact[], userDecided: Set<string>): Contest[] {
  const byKey = new Map<string, MFact[]>();
  for (const f of truths) {
    if (f.tier !== 'primary' || f.type === 'vital' || isCorrection(f) || f.separate || !f.key || !isDay(f.date)) continue;
    const list = byKey.get(f.key);
    if (list) list.push(f);
    else byKey.set(f.key, [f]);
  }
  const out: Contest[] = [];
  const contest = (records: MFact[]) => {
    const sorted = [...records].sort((a, b) => a.date!.localeCompare(b.date!) || a.documentTitle.localeCompare(b.documentTitle) || a.id.localeCompare(b.id));
    out.push({ key: sorted[0].key!, type: sorted[0].type, date: sorted[0].date!, records: sorted, documentCount: new Set(sorted.map((r) => r.documentId)).size });
  };
  const declined = (as: MFact[], bs: MFact[]) => as.some((a) => bs.some((b) => userDecided.has(pairKey(a.id, b.id))));
  const push = <T>(map: Map<string, T[]>, k: string, v: T) => {
    const list = map.get(k);
    if (list) list.push(v);
    else map.set(k, [v]);
  };
  for (const list of byKey.values()) {
    if (new Set(list.map((f) => f.sourceKey)).size < 2) continue;
    if (comparedByValue(list[0].type)) {
      const byDay = new Map<string, MFact[]>();
      for (const f of list) push(byDay, f.date!, f);
      for (const day of byDay.values()) {
        // A record that restates a reading the subject's own report gives that day (from another document) is
        // backed by it: a clinic note quoting one lab report and a discharge summary quoting another are two real
        // readings, never a disagreement. Only a reading clearly the same backs it: two records the report cannot be
        // compared with (in another unit) are still compared with each other, and contest when they disagree.
        const reports = day.filter(ownReport);
        const backed = (f: MFact) => !ownReport(f) && reports.some((p) => p.sourceKey !== f.sourceKey && sameValue(f.type, f.value, p.value));
        const byDoc = new Map<string, MFact[]>();
        for (const f of day) if (!backed(f)) push(byDoc, f.sourceKey, f);
        if (byDoc.size < 2) continue;
        const docs = [...byDoc.values()];
        const contestants = new Set<MFact>();
        for (let i = 0; i < docs.length; i++) {
          for (let j = i + 1; j < docs.length; j++) {
            // Only the readings that may contest are compared (against a lab report, the restating document's
            // readings the user said are accurate; the others were compared with the report already).
            const as = docs[i].filter((a) => docs[j].some((b) => mayContest(a, b)));
            const bs = docs[j].filter((b) => as.some((a) => mayContest(a, b)));
            if (!as.length || !bs.length || declined(as, bs)) continue;
            // Neither is the record of the other: a limit and a measurement inside it ("<3" and 2) do not disagree.
            if (!as.some((a) => bs.some((b) => !differsEitherWay(a.type, a.value, b.value)))) {
              for (const f of [...as, ...bs]) contestants.add(f);
            }
          }
        }
        // Only the records of the pairs that disagree, never every record of the day.
        if (contestants.size) contest([...contestants]);
      }
      continue;
    }
    const w = list[0].window;
    if (!w) continue;
    const datesOf = new Map<string, Set<string>>();
    for (const f of list) {
      const set = datesOf.get(f.sourceKey);
      if (set) set.add(f.date!);
      else datesOf.set(f.sourceKey, new Set([f.date!]));
    }
    const parent = new Map<string, string>();
    const find = (id: string): string => {
      let r = id;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(id, r);
      return r;
    };
    const live = list.filter((f) => !exactOnly(f));
    for (const f of live) parent.set(f.id, f.id);
    // A record whose date the subject's own report gives (another document: the procedure report of that day) is
    // backed by it: a clinic note and a discharge summary quoting two real lumbar punctures do not disagree.
    const backedDate = (f: MFact) => !ownReport(f) && list.some((p) => ownReport(p) && p.sourceKey !== f.sourceKey && p.date === f.date);
    let any = false;
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        if (!mayContest(a, b) || a.date === b.date || Math.abs(daysBetween(a.date!, b.date!)) > w || backedDate(a) || backedDate(b)) continue;
        if (datesOf.get(b.sourceKey)!.has(a.date!) || datesOf.get(a.sourceKey)!.has(b.date!) || userDecided.has(pairKey(a.id, b.id))) continue;
        parent.set(find(a.id), find(b.id));
        any = true;
      }
    }
    if (!any) continue;
    const groups = new Map<string, MFact[]>();
    for (const f of live) push(groups, find(f.id), f);
    for (const g of groups.values()) if (g.length > 1) contest(g);
  }
  return out;
}

function prepareLedger(): Ledger {
  const d = db();
  const facts = loadFacts();
  const byId = new Map(facts.map((f) => [f.id, f]));
  const fm = schema.factMerges;
  const linksByS = new Map<string, MergeRow[]>();
  for (const r of d.select().from(fm).where(inArray(fm.reason, LINK_REASONS)).all()) {
    const list = linksByS.get(r.factIdB);
    if (list) list.push(r);
    else linksByS.set(r.factIdB, [r]);
  }
  // Pairs the user already decided about as possible duplicates (rejected as not duplicates, or merged and put
  // back): never compared with each other, and their rows are never rewritten.
  const userDecided = new Set<string>();
  for (const r of d.select({ a: fm.factIdA, b: fm.factIdB }).from(fm).where(and(ne(fm.status, 'pending'), notInArray(fm.reason, LINK_REASONS))).all()) userDecided.add(pairKey(r.a, r.b));
  const active = new Map<string, MergeRow>();
  for (const f of facts) {
    if (f.status !== 'superseded') continue;
    const row = (linksByS.get(f.id) ?? []).find((r) => r.reason === CLINICAL_RECORD_REASON && r.status === 'accepted' && r.factIdA === f.supersededById);
    if (row) active.set(f.id, row);
  }
  // A record: a live, undisputed, not replaced fact of a live primary document that the user did not mark "Not
  // sure" (a copy whose document became primary counts at once; the pass restores it).
  const records = facts.filter((f) => f.key && isDay(f.date) && f.tier === 'primary' && (recordEligible(f) || (f.status === 'superseded' && active.has(f.id))));
  // The patient's corrections, latest first: a later one outranks an older one it disagrees with (on its own day,
  // else the nearest one within the window).
  const corrections = facts.filter((f) => f.key && isDay(f.date) && isCorrection(f)).sort((a, b) => (b.verdictAt ?? '').localeCompare(a.verdictAt ?? '') || a.id.localeCompare(b.id));
  const outranked = new Map<string, MFact>();
  const liveCorrections: MFact[] = [];
  for (let i = 0; i < corrections.length; i++) {
    const c = corrections[i];
    if (outranked.has(c.id)) continue;
    liveCorrections.push(c);
    for (const o of reachOf(c, corrections.slice(i + 1), userDecided, false)) if (!outranked.has(o.id)) outranked.set(o.id, c);
  }
  // Each live correction outranks the record of its own event: on its own day the ones that say otherwise, else the
  // nearest within the window. Records of other occasions keep their word.
  const recordsByKey = new Map<string, MFact[]>();
  for (const p of records) {
    if (isCorrection(p)) continue;
    const list = recordsByKey.get(p.key!);
    if (list) list.push(p);
    else recordsByKey.set(p.key!, [p]);
  }
  const chosen = new Set<string>();
  for (const c of liveCorrections) {
    const pool = recordsByKey.get(c.key!) ?? [];
    const reach = reachOf(c, pool, userDecided, true);
    for (const p of reach) if (!outranked.has(p.id)) outranked.set(p.id, c);
    // A record of its day is there and it says nothing against it (it agrees, or it is in another unit): the user chose
    // this value as the right one; the record was not corrected.
    if (c.tier !== 'primary' && !reach.length && pool.some((p) => p.date === c.date)) {
      chosen.add(c.id);
      c.chosenValue = true;
    }
  }
  const truths: MFact[] = [];
  const seen = new Set<string>();
  for (const f of [...records, ...liveCorrections]) {
    if (seen.has(f.id) || outranked.has(f.id)) continue;
    seen.add(f.id);
    truths.push(f);
  }
  // A clinical record restating the subject's own report and saying something else is compared with the report
  // (inaccurate, never changed). Clinical records that disagree with each other otherwise are no one's truth until
  // the user chooses one (This one is right) or says both happened: they, and the mentions of their event, need a
  // source.
  const restated = findRestatements(truths, userDecided);
  const contests = findContests(restated.size ? truths.filter((f) => !restated.has(f.id)) : truths, userDecided);
  const contestOf = new Map<string, Contest>();
  const contestedByKey = new Map<string, MFact[]>();
  for (const c of contests) {
    for (const r of c.records) contestOf.set(r.id, c);
    contestedByKey.set(c.key, [...(contestedByKey.get(c.key) ?? []), ...c.records]);
  }
  const truthByKey = new Map<string, MFact[]>();
  const truthIds = new Set<string>();
  for (const f of truths) {
    if (contestOf.has(f.id) || restated.has(f.id)) continue;
    truthIds.add(f.id);
    const list = truthByKey.get(f.key!);
    if (list) list.push(f);
    else truthByKey.set(f.key!, [f]);
  }
  return { facts, byId, linksByS, active, userDecided, truthByKey, truthIds, outranked, chosen, restated, contestOf, contestedByKey, contests };
}

export interface Match {
  p: MFact;
  /** Same day and same value (or a month/year copy). */
  same: boolean;
  /** Matched on a near day (never the same). */
  near: boolean;
  /** The other verified details that day when they give several readings and the mention matches none: the reason names them all. */
  others?: MFact[];
  /** The record that fits is one of clinical records that disagree: the mention belongs to that contest (needs a source). */
  contest?: Contest;
  /**
   * A record is there but the mention could not be compared with it: on its own day every reading is in another unit
   * that does not convert or in other words (a scan impression not worded nearly identically); the mention names no
   * sample and that day's records give the test for several (`noSample`); or the mention gives only the month (or
   * year) and the record of that period says something else or gives several readings. Neither accurate nor
   * inaccurate: nothing is set aside, and the trust names what the record gives.
   */
  notCompared?: boolean;
  /** Not compared because the mention names no sample and that day's records give the test for several (sampleKeys). */
  noSample?: boolean;
  /**
   * The mention is dated on the day the record's lab report printed as its resulted (reported) date, not on the
   * record's own date: the same result, told by the date it came back (compared as on its own day, never "near").
   */
  resulted?: boolean;
}

/**
 * The verified fact (or correction) a mention records, if one fits:
 * - both dated to the same day: only the readings it can be compared with count (none: `notCompared`, naming the
 *   day's readings); a copy of any of them wins; with several readings that day (one document's set, or readings
 *   the user said both happened) and none equal, it is inaccurate against them all. A scan impression is only ever
 *   a copy (worded nearly identically) or not compared, never inaccurate for its wording;
 * - no record on its own day, but a lab record whose report printed that day as its resulted date (`resulted`): the
 *   same comparison with those records, as if on their own day (a summary dates a result by the day it came back).
 *   Not for a mention or record compared on its own date only;
 * - a lab that names no sample, with no record of its own key that day but records of that test for several samples
 *   (sampleKeys): `notCompared` and `noSample`, naming them all;
 * - no verified fact on its own day: the nearest one within the window (a lab 3 days; a procedure, scan or event 7;
 *   a vital or a repeated treatment only its own day), always a disagreement (the date differs), unless either side
 *   is compared on its own date only;
 * - the mention dated to a month or year: exactly one reading inside it with the same value (a copy); a different
 *   value that month (or several readings) may be another test, so it is left alone (`notCompared`, naming them).
 * Clinical records that disagree with each other are candidates too: when one of them is what fits, the mention is
 * part of their contest (`contest`), never accurate or inaccurate.
 * A verified fact the user said this is not a duplicate of is never matched. `prefer` keeps an existing link when it
 * is still one of the right answers.
 */
function findMatch(s: MFact, L: Ledger, prefer: string | null): Match | null {
  if (!s.key) return null;
  const all = L.truthByKey.get(s.key) ?? [];
  const contested = L.contestedByKey.get(s.key) ?? [];
  if (s.sampleKeys && isDay(s.date) && !all.some((p) => p.date === s.date) && !contested.some((p) => p.date === s.date)) {
    const m = sampleMatch(s, L);
    if (m) return m;
  }
  if (!all.length && !contested.length) return null;
  const ok = (p: MFact) => p.id !== s.id && !L.userDecided.has(pairKey(s.id, p.id));
  const pick = (list: MFact[]): MFact => list.find((p) => p.id === prefer) ?? [...list].sort(byPreference)[0];
  const contestMatch = (p: MFact, near: boolean): Match => ({ p, same: false, near, contest: L.contestOf.get(p.id) });
  if (isDay(s.date)) {
    const sDate = s.date;
    const disputedDay = contested.find((p) => p.date === sDate && ok(p));
    if (disputedDay) return contestMatch(disputedDay, false);
    let sameDay = all.filter((p) => p.date === sDate && ok(p));
    // No record on its own day: a lab record whose report printed this day as its resulted date is the same result,
    // dated by the day it came back ("matches the lab report; this document gives the date it was resulted"). Never
    // for a mention or a record compared on its own date only.
    let resulted = false;
    if (!sameDay.length) {
      const onResulted = (p: MFact) => p.resultedDay === sDate && p.date !== sDate && ok(p) && !exactOnly(s) && !exactOnly(p);
      const disputedResulted = contested.find(onResulted);
      if (disputedResulted) return { ...contestMatch(disputedResulted, false), resulted: true };
      sameDay = all.filter(onResulted);
      resulted = sameDay.length > 0;
    }
    if (sameDay.length) {
      const r = resulted ? { resulted: true } : {};
      // Only what it can be compared with: a value in a unit that does not convert ("6.2 mmol/L" against "112
      // mg/dL"), or other words that are no known answer, is not compared (and never read as a wrong date either).
      const cands = sameDay.filter((p) => comparable(s.type, s.value, p.value));
      if (!cands.length) {
        const p = pick(sameDay);
        const others = sameDay.filter((q) => q !== p);
        return others.length ? { p, same: false, near: false, notCompared: true, others, ...r } : { p, same: false, near: false, notCompared: true, ...r };
      }
      const equal = cands.filter((p) => sameValue(s.type, s.value, p.value));
      if (equal.length) return { p: pick(equal), same: true, near: false, ...r };
      const p = pick(cands);
      // Several readings that day (one document's set, or readings the user said both happened): it is compared
      // with all of them, and the reason names each.
      const several = cands.some((q) => !sameEither(q.type, q.value, p.value));
      return several ? { p, same: false, near: false, others: cands.filter((q) => q !== p), ...r } : { p, same: false, near: false, ...r };
    }
    const w = s.window;
    if (!w || exactOnly(s)) return null;
    let best: MFact | null = null;
    let bestDays = Infinity;
    for (const p of contested.length ? [...all, ...contested] : all) {
      if (!ok(p) || !isDay(p.date) || exactOnly(p)) continue;
      const dd = Math.abs(daysBetween(sDate, p.date));
      if (dd > w) continue;
      if (!best || dd < bestDays) {
        best = p;
        bestDays = dd;
        continue;
      }
      if (dd > bestDays) continue;
      // A tie: the one kept before, then the same value, then the earlier date, then the earlier choice.
      const score = (q: MFact) => [q.id === prefer ? 0 : 1, sameValue(s.type, s.value, q.value) ? 0 : 1] as const;
      const [pa, pb] = score(p);
      const [ba, bb] = score(best);
      if (pa < ba || (pa === ba && (pb < bb || (pb === bb && (p.date < best.date! || (p.date === best.date && byPreference(p, best) < 0)))))) best = p;
    }
    if (best && L.contestOf.has(best.id)) return contestMatch(best, true);
    return best ? { p: best, same: false, near: true } : null;
  }
  if (isCoarse(s.date)) {
    const month = `${s.date}-`;
    if (contested.some((p) => ok(p) && isDay(p.date) && p.date.startsWith(month))) return null;
    const cands = all.filter((p) => ok(p) && isDay(p.date) && p.date.startsWith(month));
    if (!cands.length) return null;
    const equal = readings(cands) === 1 ? cands.filter((p) => sameValue(s.type, s.value, p.value)) : [];
    if (equal.length) return { p: pick(equal), same: true, near: false };
    const byDate = [...cands].sort((a, b) => a.date!.localeCompare(b.date!) || byPreference(a, b));
    return byDate.length > 1 ? { p: byDate[0], same: false, near: false, notCompared: true, others: byDate.slice(1) } : { p: byDate[0], same: false, near: false, notCompared: true };
  }
  return null;
}

/**
 * A lab mention that names no sample, on a day whose clinical records give that test for several samples ("Glucose
 * 60 mg/dL" while the lab report gives CSF glucose 60 and serum glucose 95): not compared, naming every reading. The
 * record named first (recordFactId) is one with the same value when there is one, else the first by preference.
 */
function sampleMatch(s: MFact, L: Ledger): Match | null {
  const ps = (s.sampleKeys ?? []).flatMap((k) => L.truthByKey.get(k) ?? []).filter((p) => p.date === s.date && p.id !== s.id && !L.userDecided.has(pairKey(s.id, p.id)));
  if (!ps.length) return null;
  const rank = (p: MFact) => (sameValue(s.type, s.value, p.value) ? 0 : 1);
  const [p, ...others] = [...ps].sort((a, b) => rank(a) - rank(b) || byPreference(a, b));
  return others.length ? { p, same: false, near: false, notCompared: true, noSample: true, others } : { p, same: false, near: false, notCompared: true, noSample: true };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** The truth, named by its document's type ("the lab report"), or "your correction" (a record the user chose keeps its document's words). */
function recordWords(p: MFact): string {
  if (isCorrection(p) && p.tier !== 'primary') return p.chosenValue ? 'the value you chose' : 'your correction';
  switch (p.documentCategory) {
    case 'lab_report':
      return 'the lab report';
    case 'imaging_report':
      return 'the scan report';
    case 'clinical_note':
      return 'the clinic note';
    case 'discharge_summary':
      return 'the discharge summary';
    case 'operative_report':
      return 'the procedure report';
    case 'pathology':
      return 'the pathology report';
    case 'other':
    case '':
      return p.type === 'lab_result' ? 'the lab report' : p.type === 'imaging_result' ? 'the scan report' : 'the clinical record';
    default:
      return 'the clinical record';
  }
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** A subject name inside a sentence: "Blood pressure" reads "blood pressure"; "CSF protein" and "IgG index" stay. */
function inSentence(label: string): string {
  return /^[A-Z][a-z]+\b/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

const TYPE_WORDS: Record<ReconcileType, string> = { lab_result: 'Lab result', imaging_result: 'Scan', vital: 'Vital sign', procedure: 'Procedure', event: 'Event' };

function subjectLabel(f: MFact): string {
  return f.label || TYPE_WORDS[f.type] || f.type;
}

/** What a detail says, in plain words: "62 mg/dL on 2024-03-18", "2024-03-21", "in Mar 2024". */
function saysOf(f: MFact): string {
  const when = f.date ? formatPartialDate(f.date, f.datePrecision as never) : null;
  if (f.value.empty) return when ?? 'no date given';
  return when ? `${f.value.display} on ${when}` : f.value.display;
}

/**
 * The record's measurement in the mention's unit when the two units differ and convert (" (4400 mg/dL)" after "4.4
 * g/dL"), so both units are in view and neither value is relabelled; '' otherwise.
 */
function convertedWords(record: Value, mention: Value | null | undefined): string {
  if (!mention || record.num == null || mention.num == null || record.qual || !record.unit || !mention.unit || record.unit === mention.unit) return '';
  const c = convertNumber(record.num, record.unit, mention.unit);
  if (!c || numbersEqual(c.factor, 1)) return '';
  return ` (${fmtNum(c.value)} ${mention.unitShown || mention.unit})`;
}

/** ", resulted 2025-03-03" after a record matched by its lab report's resulted date. */
function resultedWords(p: MFact, m: Pick<Match, 'resulted'> | null | undefined): string {
  return m?.resulted && p.resultedDay ? `, resulted ${formatPartialDate(p.resultedDay)}` : '';
}

/**
 * "The lab report says CSF protein 62 mg/dL on 2024-03-18." In another unit that converts, the record's value is also
 * given in the mention's unit: "The lab report says albumin 4.4 g/dL (4400 mg/dL) on 2024-03-18."
 */
function recordSays(p: MFact, mention?: Value | null, m?: Pick<Match, 'resulted'> | null): string {
  const rec = cap(recordWords(p));
  const what = inSentence(subjectLabel(p));
  const day = formatPartialDate(p.date);
  if (p.type === 'imaging_result' && !p.value.empty) return endSentence(`${rec} says the ${what} of ${day} showed ${p.value.display}`);
  if (p.value.empty) return `${rec} says ${what} on ${day}${resultedWords(p, m)}.`;
  return `${rec} says ${what} ${p.value.display}${convertedWords(p.value, mention)} on ${day}${resultedWords(p, m)}.`;
}

/**
 * The record gives only a limit and the mention a measurement inside it: "The lab report gives only a limit for CSF
 * RBC on 2024-03-18 (<3 cells/uL); this document gives a measurement (2 cells/uL) that the lab report does not contain."
 */
function limitOnlyWords(p: MFact, mention: Value, m?: Pick<Match, 'resulted'> | null): string {
  const what = inSentence(subjectLabel(p));
  return `${cap(recordWords(p))} gives only a limit for ${what} on ${formatPartialDate(p.date)}${resultedWords(p, m)} (${p.value.display}); this document gives a measurement (${mention.display}) that ${recordWords(p)} does not contain.`;
}

/** A full stop, unless the sentence already ends with one (inside a quote too). */
function endSentence(s: string): string {
  return /[.!?]["”]?$/.test(s) ? s : `${s}.`;
}

/**
 * "Matches the lab report: CSF protein 66 mg/dL on 2019-03-14." Matched by the report's resulted date: "Matches the
 * lab report: CSF protein 53 mg/dL on 2019-09-23, resulted 2019-10-07; this document gives the date it was resulted."
 */
function matchesWords(p: MFact, m?: Pick<Match, 'resulted'> | null): string {
  const what = inSentence(subjectLabel(p));
  const day = formatPartialDate(p.date);
  if (p.type === 'imaging_result') return `Matches ${recordWords(p)}: the ${what} of ${day}.`;
  const resulted = resultedWords(p, m);
  return `Matches ${recordWords(p)}: ${what}${p.value.empty ? '' : ` ${p.value.display}`} on ${day}${resulted}${resulted ? '; this document gives the date it was resulted' : ''}.`;
}

function noteOf(f: MFact): string {
  return clip(f.reasonNote ?? f.verdictNote ?? '', 300) || 'no reason given';
}

/** The reason kept when the user chose a clinical record with "This one is right" and gave none. */
export const RECORD_CHOSEN_NOTE = 'This record is right.';

/** The user's reason for choosing a record, as a tail: ": <reason>" or "." when none was given. */
function chosenTail(c: MFact): string {
  const n = clip(c.reasonNote ?? c.verdictNote ?? '', 300);
  return n && n !== RECORD_CHOSEN_NOTE ? `: ${n}` : '.';
}

/** Plural of a record's words ("the lab report" -> "the lab reports"). */
function recordWordsPlural(ps: MFact[]): string {
  const words = new Set(ps.map(recordWords));
  if (words.size === 1) {
    const w = [...words][0];
    if (w !== 'your correction') return `${w}s`;
  }
  return 'the records';
}

/**
 * "The lab reports say sodium 140 mmol/L or 134 mmol/L on 2024-03-18." (several readings that day). A value in another
 * unit that converts is also given in the mention's unit, as in recordSays.
 */
function recordsSay(ps: MFact[], mention?: Value | null, m?: Pick<Match, 'resulted'> | null): string {
  const distinct = distinctReadings(ps).sort((a, b) => (a.value.num ?? Infinity) - (b.value.num ?? Infinity) || a.value.text.localeCompare(b.value.text));
  if (distinct.length < 2) return recordSays(ps[0], mention, m);
  const one = new Set(ps.map((p) => p.documentId)).size === 1;
  const rec = cap(one ? recordWords(ps[0]) : recordWordsPlural(ps));
  const verb = one ? 'says' : 'say';
  const what = inSentence(subjectLabel(ps[0]));
  const day = formatPartialDate(ps[0].date);
  const values = distinct.map((p) => (p.value.display ? `${p.value.display}${convertedWords(p.value, mention)}` : saysOf(p)));
  if (ps[0].type === 'imaging_result') return endSentence(`${rec} ${verb} the ${what} of ${day} showed ${values.join(' or ')}`);
  return `${rec} ${verb} ${what} ${values.join(' or ')} on ${day}${resultedWords(ps[0], m)}.`;
}

/** "Clinical records disagree: Lab report says 62 mg/dL on 2024-03-18, Clinic note says 94 mg/dL on 2024-03-18." */
function contestReason(c: Contest): string {
  const byDoc = new Map<string, { title: string; says: string[] }>();
  for (const r of c.records) {
    const e = byDoc.get(r.documentId) ?? { title: r.documentTitle, says: [] };
    const s = saysOf(r);
    if (!e.says.includes(s)) e.says.push(s);
    byDoc.set(r.documentId, e);
  }
  const all = [...byDoc.values()];
  const shown = all.slice(0, 4).map((e) => `${clip(e.title || 'a clinical record', 80)} says ${e.says.join(' and ')}`);
  const more = all.length - shown.length;
  return `Clinical records disagree: ${shown.join(', ')}${more ? `, and ${more} more` : ''}.`;
}

/** The plain why of an event that needs a source. */
function contestHeadline(c: Contest): string {
  return c.documentCount === 2 ? 'Two clinical records disagree' : 'Clinical records disagree';
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Ids of facts some live fact names as taking precedence over it (overridden_by_fact_id): read once per pass. */
function overridingIds(): Set<string> {
  return new Set(
    db()
      .all<{ id: string }>(sql`select distinct overridden_by_fact_id as id from facts where overridden_by_fact_id is not null and deleted_at is null`)
      .map((r) => r.id),
  );
}

function setAside(s: MFact, pId: string, now: string, overriding: Set<string>): void {
  const d = db();
  d.update(schema.facts)
    .set({ status: 'superseded', supersededById: pId, verdictBasis: null, verdictAt: now, updatedAt: now })
    .where(and(eq(schema.facts.id, s.id), eq(schema.facts.status, 'unverified')))
    .run();
  // A replaced fact takes precedence over nothing (measurements rarely do; the rule is the same as a merge's). Only a
  // fact that some fact names is looked up (the column has no index).
  if (overriding.has(s.id)) {
    d.run(sql`update facts set overridden_by_fact_id = null, override_reason = null, updated_at = ${now} where overridden_by_fact_id = ${s.id} and deleted_at is null`);
    overriding.delete(s.id);
  }
}

function repoint(s: MFact, pId: string, now: string): void {
  db().update(schema.facts).set({ supersededById: pId, verdictAt: now, updatedAt: now }).where(and(eq(schema.facts.id, s.id), eq(schema.facts.status, 'superseded'))).run();
}

/** Back to pending: exactly the state the pass found it in (unverified, no check). Its note and edits stay. */
function restore(s: MFact, now: string): void {
  db().update(schema.facts)
    .set({ status: 'unverified', supersededById: null, verdictBasis: null, verdictAt: null, updatedAt: now })
    .where(and(eq(schema.facts.id, s.id), eq(schema.facts.status, 'superseded')))
    .run();
  s.status = 'unverified';
  s.supersededById = null;
  s.verdictBasis = null;
}

/**
 * Record the link P (kept) -> S (set aside) as an accepted `clinical record`
 * merge. A row between the two is reused only when it is that same decision:
 * a pending proposal, or an earlier clinical-record link. S's other pending
 * proposals stay pending (hidden while S is set aside), so undoing the link
 * brings them back.
 */
function writeLink(pId: string, sId: string, similarity: number, now: string): void {
  const d = db();
  const m = schema.factMerges;
  const pair = d
    .select()
    .from(m)
    .where(or(and(eq(m.factIdA, pId), eq(m.factIdB, sId)), and(eq(m.factIdA, sId), eq(m.factIdB, pId))))
    .all();
  const forward = pair.find((r) => r.factIdA === pId && (r.status === 'pending' || r.reason === CLINICAL_RECORD_REASON));
  const pendingBack = pair.find((r) => r.factIdA === sId && r.status === 'pending');
  const set = { reason: CLINICAL_RECORD_REASON, similarity, status: 'accepted', decidedAt: now };
  if (forward) d.update(m).set(set).where(eq(m.id, forward.id)).run();
  else if (pendingBack) d.update(m).set({ ...set, factIdA: pId, factIdB: sId }).where(eq(m.id, pendingBack.id)).run();
  else d.insert(m).values({ id: newId(), factIdA: pId, factIdB: sId, createdAt: now, ...set }).run();
}

function undoLink(row: MergeRow, now: string): void {
  db().update(schema.factMerges).set({ status: 'rejected', decidedAt: now }).where(eq(schema.factMerges.id, row.id)).run();
}

function takeBackRow(row: MergeRow, now: string): void {
  db().update(schema.factMerges).set({ status: 'rejected', reason: CLINICAL_RECORD_TAKEN_BACK, decidedAt: now }).where(eq(schema.factMerges.id, row.id)).run();
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export type ReconcileTrigger = 'extraction' | 'classification' | 'tier' | 'delete' | 'restore' | 'verdict' | 'manual' | 'unlock' | 'import' | 'official' | 'correction';

export interface ReconcileOptions {
  trigger?: ReconcileTrigger;
  /** The document whose change started the pass (the pass always reads the whole ledger). */
  documentId?: string;
  /** Kept for the "Check again" run; the pass no longer writes findings under it. */
  runId?: string;
}

export interface ReconcileResult {
  /** Secondhand facts newly set aside as copies of a verified fact. */
  copies: number;
  /** Secondhand facts newly set aside because the verified fact says something else (a value, or a near date). */
  conflicts: number;
  /** Links moved to another verified fact (a re-extracted report, a duplicate copy, a correction). */
  repointed: number;
  /** Links undone: the secondhand fact is pending again. */
  undone: number;
  /**
   * Secondhand lab values this pass did not compare because they give only a limit and the record a measurement inside
   * it ("<3" against 2; 2026-10, D5: such a pair read as inaccurate before): left pending, or put back (also counted in
   * undone). For the one-time lab re-read's report.
   */
  notCompared: number;
  /** Links that still hold, unchanged. */
  kept: number;
  /** Disagreements with a value the user checked: nothing is changed (its trust shows the user's word). */
  userChecked: number;
  /** The pass drafts no findings any more; `retired` counts its old open findings resolved ("Moved to Reconciliation"). */
  findings: { created: number; updated: number; unchanged: number; retired: number; active: number };
  /** Always null now (no findings are written). */
  runId: string | null;
}

export function reconcileAll(_opts: ReconcileOptions = {}): ReconcileResult {
  const d = db();
  const result: ReconcileResult = { copies: 0, conflicts: 0, repointed: 0, undone: 0, notCompared: 0, kept: 0, userChecked: 0, findings: { created: 0, updated: 0, unchanged: 0, retired: 0, active: 0 }, runId: null };

  d.transaction(() => {
    const L = prepareLedger();
    const fm = schema.factMerges;
    const acceptedOf = (f: MFact) => (L.linksByS.get(f.id) ?? []).filter((r) => r.reason === CLINICAL_RECORD_REASON && r.status === 'accepted');
    const now = nowIso();
    const overriding = overridingIds();

    for (const s of L.facts) {
      let active = L.active.get(s.id) ?? null;
      let takenBack = (L.linksByS.get(s.id) ?? []).some((r) => r.reason === CLINICAL_RECORD_TAKEN_BACK);
      // An accepted link that no longer sets this fact aside: the user took it back (a verdict, a merge or a
      // supersede by hand). Recorded as such, so a later supersede by hand is never read as this pass's.
      for (const r of acceptedOf(s)) {
        if (r === active) continue;
        takeBackRow(r, now);
        takenBack = true;
      }

      if (s.tier === 'primary') {
        // Its document is a clinical record now: it is the truth itself, no longer a copy of anything. (A record's
        // own fact is never set aside, even when the patient's correction outranks it.)
        if (active) {
          restore(s, now);
          undoLink(active, now);
          result.undone++;
        }
        continue;
      }
      // The patient's correction: the truth for its event.
      if (L.truthIds.has(s.id)) continue;

      if (active && hasUserWork(s)) {
        // Edited or annotated while set aside: the user's now. Back to pending, the link taken back; the note
        // reaches the clinician again, and its trust is still compared with the record on read.
        restore(s, now);
        takeBackRow(active, now);
        result.undone++;
        takenBack = true;
        active = null;
      }

      if (active) {
        // Clinical records that disagree settle nothing, and a value that cannot be compared with the record (another
        // unit, other words) is no copy and no disagreement: a mention set aside against one is pending again.
        const m = findMatch(s, L, active.factIdA);
        if (!m || m.contest || m.notCompared) {
          restore(s, now);
          undoLink(active, now);
          result.undone++;
          if (m?.notCompared && s.type === 'lab_result' && limitAgainstMeasurement(s.value, m.p.value)) result.notCompared++;
          continue;
        }
        const similarity = m.same ? 1 : 0;
        if (m.p.id === active.factIdA) {
          if (active.similarity !== similarity) d.update(fm).set({ similarity, decidedAt: now }).where(eq(fm.id, active.id)).run();
          result.kept++;
        } else {
          repoint(s, m.p.id, now);
          undoLink(active, now);
          writeLink(m.p.id, s.id, similarity, now);
          result.repointed++;
        }
        continue;
      }

      // Set aside by something else (a merge or a newer reading chosen by hand): not this pass's to change.
      if (s.status === 'superseded') continue;

      const m = findMatch(s, L, null);
      if (m?.notCompared && !m.contest && s.type === 'lab_result' && limitAgainstMeasurement(s.value, m.p.value)) result.notCompared++;
      if (!m || m.contest || m.notCompared) continue;
      const open = s.status === 'unverified' && s.verdictBasis !== 'unsure' && s.origin === 'ai' && !hasUserWork(s) && !takenBack;
      if (open) {
        setAside(s, m.p.id, now, overriding);
        writeLink(m.p.id, s.id, m.same ? 1 : 0, now);
        if (m.same) result.copies++;
        else result.conflicts++;
      } else if (!m.same && s.status !== 'disputed') {
        result.userChecked++;
      }
    }
  });

  // The Reconciliation page replaces the one-finding-per-disagreement list: the pass's open findings are resolved
  // (a finding the user annotated stays, as the findings engine always leaves those).
  result.findings.retired = resolveRuleFindings([CLINICAL_RECORD_RULE], MOVED_TO_RECONCILIATION);
  return result;
}

/** For hooks: never throws (a failure is logged and the next pass catches up). */
export function reconcileQuietly(opts: ReconcileOptions = {}): ReconcileResult | null {
  try {
    return reconcileAll(opts);
  } catch (err) {
    console.warn(`[reconcile] clinical-record pass failed${opts.documentId ? ` for ${opts.documentId}` : ''} (${opts.trigger ?? 'manual'}): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** The full pass after an unlock (wired in src/server/index.ts). Never throws. */
export function reconcileAfterUnlock(): ReconcileResult | null {
  return reconcileQuietly({ trigger: 'unlock' });
}

// ---------------------------------------------------------------------------
// Trust, events and counts (computed on read, cached by a cheap signature)
// ---------------------------------------------------------------------------

interface EventModel {
  key: string;
  type: ReconcileType;
  subject: string;
  /** The record's date, else the earliest mention's. */
  date: string;
  dateLabel: string;
  state: ReconcileState;
  /** Listed on the Reconciliation page (a record with no other mention is not). */
  listed: boolean;
  /** The verified fact (or correction) shown as the record; null without one. */
  record: MFact | null;
  /** Every fact in the event, the record first. */
  facts: MFact[];
  /** Clinical records disagree about it (their contest); null otherwise. */
  contest: Contest | null;
  /** Plain why it needs a source; null otherwise. */
  reason: string | null;
  hay?: string;
}

interface Model {
  sig: string;
  ref: unknown;
  byId: Map<string, MFact>;
  trust: Map<string, TrustInfo>;
  match: Map<string, Match>;
  eventOf: Map<string, EventModel>;
  /** Clinical records in a contest (records that disagree). */
  contested: Set<string>;
  /** Listed events, newest first. */
  events: EventModel[];
  /** Inaccurate facts, newest first. */
  inaccurate: MFact[];
  counts: ReconcileCounts;
}

let cache: Model | null = null;

// The model holds every lab, scan, procedure and event statement: it is dropped when the case locks.
onLockChange((unlocked) => {
  if (!unlocked) cache = null;
});

/** Changes whenever anything the model reads changes (facts of these types, documents, links). One cheap query. */
function signature(): string {
  const types = sql.join(
    RECONCILED_TYPES.map((t) => sql`${t}`),
    sql`, `,
  );
  const r = db().get<{ f: string | null; d: string | null; m: string | null }>(sql`
    select
      (select count(*) || ':' || coalesce(max(updated_at), '') || ':' || coalesce(sum(deleted_at is not null), 0) || ':' ||
              total((case status when 'unverified' then 1 when 'confirmed' then 2 when 'disputed' then 3 else 4 end
                     + case coalesce(verdict_basis, '') when '' then 0 when 'original' then 10 when 'summary' then 20 when 'unsure' then 30 else 40 end
                     + length(coalesce(superseded_by_id, '')) * 100 + length(coalesce(verdict_note, '')) * 1000
                     + length(attributes_json) * 7 + length(coalesce(date, '')) * 3) * ((rowid % 997) + 1))
       from facts where type in (${types})) as f,
      (select count(*) || ':' || coalesce(max(updated_at), '') || ':' || coalesce(sum(deleted_at is not null), 0) || ':' ||
              total((length(source_tier) + length(title) * 7 + length(coalesce(category, '')) * 3) * ((rowid % 997) + 1))
       from documents) as d,
      (select count(*) || ':' || coalesce(max(decided_at), '') || ':' ||
              total((similarity + case status when 'accepted' then 2 when 'rejected' then 4 else 8 end + length(reason) * 16) * ((rowid % 997) + 1))
       from fact_merges) as m`);
  // Whether passages of an export are sources of their own (source-unit.ts) changes what may contest.
  return `${r?.f ?? ''}|${r?.d ?? ''}|${r?.m ?? ''}|${passageSourceUnitsOn() ? 'passage' : 'document'}`;
}

function getModel(): Model {
  const ref = db();
  const sig = signature();
  if (cache && cache.ref === ref && cache.sig === sig) return cache;
  cache = buildModel(sig, ref);
  return cache;
}

/** Forget the cached model (tests; the signature already notices every change made through the app). */
export function resetReconcileCache(): void {
  cache = null;
}

/** Whether a model is held in memory (tests: it is dropped on lock). */
export function reconcileCacheHeld(): boolean {
  return cache !== null;
}

/**
 * The record a detail is compared with. `recordByUser`: it stands on the user's own word (their correction, a clinical
 * record they chose with This one is right, or a later correction), so what undoes it is that answer, never "The
 * record is wrong".
 */
function recordFields(p: MFact): Pick<TrustInfo, 'recordFactId' | 'recordDocumentId' | 'recordDocumentTitle' | 'recordValue' | 'recordDate' | 'recordByUser'> {
  return { recordFactId: p.id, recordDocumentId: p.documentId, recordDocumentTitle: p.documentTitle, recordValue: saysOf(p), recordDate: p.date, recordByUser: isCorrection(p) };
}

const NO_RECORD = { recordFactId: null, recordDocumentId: null, recordDocumentTitle: null, recordValue: null, recordDate: null, recordByUser: false };

function eventBase(f: MFact): string {
  return `${f.type}|${(f.key ?? '').split('|').slice(1).join('|')}`;
}

function buildModel(sig: string, ref: unknown): Model {
  const L = prepareLedger();
  const match = new Map<string, Match>();
  const replaced = (f: MFact) => f.status === 'superseded' && !L.active.has(f.id);

  for (const f of L.facts) {
    if (L.truthIds.has(f.id) || L.contestOf.has(f.id) || replaced(f)) continue;
    const c = L.outranked.get(f.id);
    if (c) {
      match.set(f.id, { p: c, same: false, near: f.date !== c.date });
      continue;
    }
    const r = L.restated.get(f.id);
    if (r) {
      match.set(f.id, r);
      continue;
    }
    const link = L.active.get(f.id);
    const linked = link ? L.byId.get(link.factIdA) : undefined;
    if (link && linked && f.tier !== 'primary' && L.truthIds.has(linked.id)) {
      // The pass's link is what is stored; it says which record and whether the value is a copy.
      // A mention dated on the record's resulted day is the same result (findMatch), never matched on a near day.
      const resulted = f.date !== linked.date && isDay(f.date) && linked.resultedDay === f.date;
      const m: Match = { p: linked, same: link.similarity >= 1, near: f.date !== linked.date && !resulted, ...(resulted ? { resulted } : {}) };
      if (!m.same && !m.near) {
        // Several readings that day: the reason names them all (those it can be compared with, as findMatch does).
        const onDay = (q: MFact) => (resulted ? q.resultedDay === f.date && q.date !== f.date && !exactOnly(q) : q.date === linked.date);
        const day = (L.truthByKey.get(linked.key!) ?? []).filter((q) => onDay(q) && q !== linked && comparable(f.type, f.value, q.value));
        if (day.some((q) => !sameEither(q.type, q.value, linked.value))) m.others = day;
      }
      match.set(f.id, m);
      continue;
    }
    const m = findMatch(f, L, null);
    if (m) match.set(f.id, m);
  }

  // Events: one per verified date (records and corrections), the mentions that match it; one per set of clinical
  // records that disagree, with the mentions of that event; then the rest clustered.
  const events: EventModel[] = [];
  const eventOf = new Map<string, EventModel>();
  const usedKeys = new Set<string>();
  const uniqueKey = (base: string): string => {
    let k = base;
    for (let i = 2; usedKeys.has(k); i++) k = `${base}|${i}`;
    usedKeys.add(k);
    return k;
  };
  const truthEvent = new Map<string, EventModel>();
  const truths = L.facts.filter((f) => L.truthIds.has(f.id)).sort((a, b) => a.key!.localeCompare(b.key!) || a.date!.localeCompare(b.date!) || byPreference(a, b));
  for (const t of truths) {
    const tk = `${t.key}\u001f${t.date}`;
    let ev = truthEvent.get(tk);
    if (!ev) {
      ev = { key: uniqueKey(`${eventBase(t)}|${t.date}`), type: t.type, subject: subjectLabel(t), date: t.date!, dateLabel: '', state: 'settled', listed: false, record: t, facts: [], contest: null, reason: null };
      truthEvent.set(tk, ev);
      events.push(ev);
    }
    ev.facts.push(t);
    eventOf.set(t.id, ev);
  }
  const contestEvent = new Map<Contest, EventModel>();
  const contests = [...L.contests].sort((a, b) => a.key.localeCompare(b.key) || a.date.localeCompare(b.date) || a.records[0].id.localeCompare(b.records[0].id));
  for (const c of contests) {
    const first = c.records[0];
    const ev: EventModel = { key: uniqueKey(`${eventBase(first)}|${c.date}`), type: c.type, subject: subjectLabel(first), date: c.date, dateLabel: '', state: 'needs_source', listed: true, record: null, facts: [...c.records], contest: c, reason: contestHeadline(c) };
    contestEvent.set(c, ev);
    events.push(ev);
    for (const r of c.records) eventOf.set(r.id, ev);
  }
  // Values not compared with the record of their own day (another unit, other words) that clearly disagree with each
  // other between documents (5.4 and 7.1 mmol/L while the lab report gives 97 mg/dL): the user cannot convert units
  // himself, so they are listed together as a disagreement that needs a source, never settled quietly. A mention that
  // names no sample is left out (two such mentions may be the CSF and the serum value, both right).
  const notComparedByDay = new Map<string, MFact[]>();
  for (const f of L.facts) {
    if (L.truthIds.has(f.id) || L.contestOf.has(f.id) || replaced(f)) continue;
    const m = match.get(f.id);
    if (!m?.notCompared || m.noSample || !isDay(f.date)) continue;
    const k = `${m.p.key}\u001f${m.p.date}`;
    const list = notComparedByDay.get(k);
    if (list) list.push(f);
    else notComparedByDay.set(k, [f]);
  }
  const notComparedEvent = new Map<string, EventModel>();
  for (const k of [...notComparedByDay.keys()].sort()) {
    const list = notComparedByDay.get(k)!;
    if (!disagree(list)) continue;
    const m = match.get(list[0].id)!;
    // The record gives several readings that day (CSF glucose 112 and 60 mg/dL): values in another unit (6.2 and 3.3
    // mmol/L) may each be one of them. The app cannot convert them, so they disagree only when they give more values
    // than the record has readings (then one of them matches none).
    const n = readings([m.p, ...(m.others ?? [])]);
    if (n > 1 && valueCount(list) <= n) continue;
    // The reason ends with what the record gives, so this event is told apart from the record's own (settled) one.
    const ev: EventModel = { key: uniqueKey(`${eventBase(m.p)}|${m.p.date}`), type: m.p.type, subject: subjectLabel(m.p), date: m.p.date!, dateLabel: '', state: 'needs_source', listed: true, record: null, facts: [], contest: null, reason: notComparedDisagreeReason(list[0], m) };
    notComparedEvent.set(k, ev);
    events.push(ev);
  }
  const unmatched: MFact[] = [];
  for (const f of L.facts) {
    if (L.truthIds.has(f.id) || L.contestOf.has(f.id) || replaced(f)) continue;
    const m = match.get(f.id);
    // A value not compared with the record of its own day belongs to the record's event (settled; the record is there,
    // so it is not waiting for one), unless such values disagree with each other (above). A month-only mention the
    // record of that month cannot settle stays with its month.
    const ownMonth = m?.notCompared && !isDay(f.date);
    const dayKey = m ? `${m.p.key}\u001f${m.p.date}` : '';
    const ev = m?.contest ? contestEvent.get(m.contest) : m && !ownMonth ? (m.notCompared && !m.noSample && notComparedEvent.get(dayKey)) || truthEvent.get(dayKey) : undefined;
    if (ev) {
      ev.facts.push(f);
      ev.listed = true;
      eventOf.set(f.id, ev);
    } else if (f.key && f.date && (isDay(f.date) || isCoarse(f.date))) unmatched.push(f);
  }

  // Mentions nothing verified backs: near days chained from the earliest (within the window), a mention compared
  // on its own date only (a vital, a repeated treatment, one the user said is another occasion, or one its document
  // gives beside another day) by itself (with others of that date), a month or year by itself.
  const clusters: MFact[][] = [];
  const near = new Map<string, MFact[]>();
  const own = new Map<string, MFact[]>();
  const add = (map: Map<string, MFact[]>, k: string, f: MFact) => {
    const list = map.get(k);
    if (list) list.push(f);
    else map.set(k, [f]);
  };
  for (const f of unmatched) {
    if (isDay(f.date) && !exactOnly(f) && f.window) add(near, f.key!, f);
    else add(own, `${f.key}\u001f${f.date}\u001f${isDay(f.date) ? 'day' : 'coarse'}`, f);
  }
  for (const list of near.values()) {
    list.sort((a, b) => a.date!.localeCompare(b.date!) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const w = list[0].window;
    let cur: MFact[] = [];
    let anchor = '';
    for (const f of list) {
      if (cur.length && daysBetween(anchor, f.date!) <= w) cur.push(f);
      else {
        if (cur.length) clusters.push(cur);
        cur = [f];
        anchor = f.date!;
      }
    }
    if (cur.length) clusters.push(cur);
  }
  for (const list of own.values()) clusters.push(list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
  clusters.sort((a, b) => a[0].key!.localeCompare(b[0].key!) || dateSortKey(a[0].date).localeCompare(dateSortKey(b[0].date)) || a[0].id.localeCompare(b[0].id));
  for (const list of clusters) {
    const first = list[0];
    const coarse = !isDay(first.date);
    const state: ReconcileState = !coarse && disagree(list) ? 'needs_source' : 'unbacked';
    // A clinical record's own detail (a month-only "LP, March 2024" in a clinic note) reads verified: with nothing
    // else beside it, it is not listed as waiting for a record, unless clinical records from different documents give
    // different values that month (a clinic note's 62 mg/dL and a discharge summary's 94 mg/dL): those stay in view.
    const recs = list.filter((f) => f.tier === 'primary' && recordEligible(f));
    const listed = recs.length < list.length || recs.some((a, i) => recs.slice(i + 1).some((b) => a.sourceKey !== b.sourceKey && !sameEither(a.type, a.value, b.value)));
    const ev: EventModel = { key: uniqueKey(`${eventBase(first)}|${first.date}`), type: first.type, subject: subjectLabel(first), date: first.date!, dateLabel: '', state, listed, record: null, facts: list, contest: null, reason: state === 'needs_source' ? 'The documents disagree' : null };
    events.push(ev);
    for (const f of list) eventOf.set(f.id, ev);
  }
  for (const ev of events) ev.dateLabel = dateLabelOf(ev);

  // Trust.
  const trust = new Map<string, TrustInfo>();
  for (const f of L.facts) trust.set(f.id, deriveTrust(f, L, match.get(f.id) ?? null, eventOf.get(f.id) ?? null));

  const listed = events.filter((e) => e.listed);
  const newestFirst = (a: { date: string | null; subject: string; id: string }, b: { date: string | null; subject: string; id: string }) =>
    dateSortKey(b.date).localeCompare(dateSortKey(a.date)) || a.subject.localeCompare(b.subject) || a.id.localeCompare(b.id);
  listed.sort((a, b) => newestFirst({ date: a.date, subject: a.subject, id: a.key }, { date: b.date, subject: b.subject, id: b.key }));
  const inaccurate = L.facts
    .filter((f) => trust.get(f.id)?.trust === 'inaccurate')
    .sort((a, b) => newestFirst({ date: a.date, subject: subjectLabel(a), id: `${a.documentTitle}\u001f${a.id}` }, { date: b.date, subject: subjectLabel(b), id: `${b.documentTitle}\u001f${b.id}` }));
  const counts: ReconcileCounts = {
    needsSource: listed.filter((e) => e.state === 'needs_source').length,
    inaccurate: inaccurate.length,
    settled: listed.filter((e) => e.state === 'settled').length,
    unbacked: listed.filter((e) => e.state === 'unbacked').length,
  };
  return { sig, ref, byId: L.byId, trust, match, eventOf, contested: new Set(L.contestOf.keys()), events: listed, inaccurate, counts };
}

/** Do the mentions of an event nothing verified backs disagree (a different day, or a different value that day), between documents? */
function disagree(list: MFact[]): boolean {
  // A mention the user marked wrong does not count; one document's own lines never disagree with each other.
  const seen = new Map<string, MFact>();
  for (const f of list) {
    if (f.status === 'disputed') continue;
    const k = `${f.sourceKey}\u001f${f.date}\u001f${valueKey(f.value)}`;
    if (!seen.has(k)) seen.set(k, f);
  }
  const live = [...seen.values()];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (a.sourceKey === b.sourceKey) continue;
      if (a.date !== b.date) return true;
      // Values that cannot be compared (another unit that does not convert, other words, a limit and a measurement
      // inside it) do not disagree.
      if (differsEitherWay(a.type, a.value, b.value)) return true;
    }
  }
  return false;
}

/** How many different values these mentions give (one the user marked wrong left out; equal values counted once). */
function valueCount(list: MFact[]): number {
  const seen: MFact[] = [];
  for (const f of list) if (f.status !== 'disputed' && !seen.some((q) => sameEither(q.type, q.value, f.value))) seen.push(f);
  return seen.length;
}

function dateLabelOf(ev: EventModel): string {
  if (!isDay(ev.date)) return `in ${formatPartialDate(ev.date)}`;
  const days = new Set(ev.facts.filter((f) => isDay(f.date)).map((f) => f.date));
  return days.size > 1 ? `around ${ev.date}` : `on ${ev.date}`;
}

/**
 * What the record (or the records, several readings that day) says, for an inaccurate mention (`mention` its value: a
 * value in another unit that converts is also given in the mention's unit). A record that gives only a limit against
 * a measurement inside it, that day (a near day is told by its date as before): "The lab report gives only a limit for
 * CSF RBC on 2024-03-18 (<3 cells/uL); this document
 * gives a measurement (2 cells/uL) that the lab report does not contain."
 */
function mismatchWords(m: Match, mention?: Value | null): string {
  if (mention && !m.near && !m.others?.length && measurementInsideLimit(mention, m.p.value)) return limitOnlyWords(m.p, mention, m);
  return m.others?.length ? recordsSay([m.p, ...m.others], mention, m) : recordSays(m.p, mention, m);
}

/** One reading as given: 112 mg/dL on 2024-03-18; on 2024-03-18 (a procedure); "Normal MRI." for the MRI brain of 2024-03-18. */
function readingWords(p: MFact, what: string): string {
  const day = formatPartialDate(p.date);
  if (p.type === 'imaging_result') return p.value.empty ? `the ${what} of ${day}` : `${p.value.display} for the ${what} of ${day}`;
  return p.value.empty ? `on ${day}` : `${p.value.display} on ${day}`;
}

/** "the lab report gives CSF glucose 112 mg/dL on 2024-03-18" (several readings: each, "or" on one day, "and" across days). */
function givesWords(ps: MFact[]): string {
  const distinct = distinctReadings(ps).sort((a, b) => a.date!.localeCompare(b.date!) || (a.value.num ?? Infinity) - (b.value.num ?? Infinity) || a.value.text.localeCompare(b.value.text));
  const one = new Set(ps.map((p) => p.documentId)).size === 1;
  const rec = one ? recordWords(ps[0]) : recordWordsPlural(ps);
  const verb = one ? 'gives' : 'give';
  const what = inSentence(subjectLabel(ps[0]));
  if (ps[0].type === 'imaging_result') return `${rec} ${verb} ${distinct.map((p) => readingWords(p, what)).join(' and ')}`;
  const oneDay = new Set(distinct.map((p) => p.date)).size === 1;
  if (oneDay && distinct.length > 1 && distinct.every((p) => !p.value.empty)) return `${rec} ${verb} ${what} ${distinct.map((p) => p.value.display).join(' or ')} on ${formatPartialDate(distinct[0].date)}`;
  return `${rec} ${verb} ${what} ${distinct.map((p) => readingWords(p, what)).join(' and ')}`;
}

/**
 * Why a value was not compared with the record that is there, and what the record gives: "Not compared: the lab
 * report gives CSF glucose 97 mg/dL on 2019-03-14 (another unit)."; a month-only mention: "Not compared: this gives
 * only the month, and the lab report gives CSF protein 66 mg/dL on 2019-03-14."
 */
function notComparedReason(f: MFact, m: Match): string {
  const ps = [m.p, ...(m.others ?? [])];
  if (m.noSample) return `Not compared: it does not name the sample, and ${samplesWords(ps)}.`;
  if (!isDay(f.date)) return `Not compared: this gives only the ${(f.date ?? '').length === 4 ? 'year' : 'month'}, and ${givesWords(ps)}.`;
  if (f.type === 'imaging_result') return scanNotComparedReason(ps);
  return notComparedWithRecords(f.type, f.value, ps, m);
}

/** The record's words, or several records' (one document: "the scan report says"; more: "the scan reports say"). */
function recordVerb(ps: MFact[], singular: string, plural: string): string {
  const one = new Set(ps.map((p) => p.documentId)).size === 1;
  return `${one ? recordWords(ps[0]) : recordWordsPlural(ps)} ${one ? singular : plural}`;
}

/** A scan impression quoted in a reason, clipped (its own double quotes made single, so the quote reads whole). */
function quoteImpression(p: MFact, n: number): string {
  return `"${clip((p.value.words ?? '').replace(/["“”]/g, "'"), n)}"`;
}

/**
 * A scan worded otherwise than the record of its day: not compared, with the report's own words to read beside it:
 * 'Not compared: the scan report says "Diffuse smooth pachymeningeal enhancement…". Read both.'
 */
function scanNotComparedReason(ps: MFact[]): string {
  const said = [...new Set(ps.filter((p) => !p.value.empty && p.value.words).map((p, _i, all) => quoteImpression(p, all.length > 1 ? 200 : 300)))];
  if (!said.length) return `Not compared: ${recordVerb(ps, 'gives', 'give')} no impression for the ${inSentence(subjectLabel(ps[0]))} of ${formatPartialDate(ps[0].date)}. Read the report.`;
  // One full stop: none after a quote that already ends a sentence ('says "Brain sagging." Read both.').
  return `${endSentence(`Not compared: ${recordVerb(ps, 'says', 'say')} ${said.join(' and ')}`)} ${said.length > 1 ? 'Read them all.' : 'Read both.'}`;
}

const SAMPLE_WORDS: Record<string, string> = { csf: 'CSF', serum: 'serum', plasma: 'plasma', whole_blood: 'whole blood', blood: 'blood', urine: 'urine' };

/** A lab record's test with its sample when the name does not say it ("serum glucose", "CSF glucose"). */
function sampleLabel(p: MFact): string {
  const label = inSentence(subjectLabel(p));
  const word = SAMPLE_WORDS[(p.key ?? '').split('|').pop() ?? ''];
  return word && !label.toLowerCase().includes(word.toLowerCase()) ? `${word} ${label}` : label;
}

/** "the lab report gives CSF glucose 60 mg/dL and serum glucose 95 mg/dL on 2024-03-18" (each reading with its sample). */
function samplesWords(ps: MFact[]): string {
  const items: string[] = [];
  const sorted = [...ps].sort((a, b) => (a.key ?? '').localeCompare(b.key ?? '') || (a.value.num ?? Infinity) - (b.value.num ?? Infinity) || a.value.text.localeCompare(b.value.text));
  for (const p of sorted) {
    const w = p.value.empty ? sampleLabel(p) : `${sampleLabel(p)} ${p.value.display}`;
    if (!items.includes(w)) items.push(w);
  }
  return `${recordVerb(ps, 'gives', 'give')} ${items.join(' and ')} on ${formatPartialDate(ps[0].date)}`;
}

/**
 * Values the record of their day could not be compared with that disagree with each other between documents (6.2 and
 * 8.0 mmol/L while the lab report gives 112 mg/dL): "These documents give different values, and the lab report gives
 * it in another unit".
 */
function notComparedDisagreeHead(f: MFact, m: Match): string {
  const rec = recordVerb([m.p, ...(m.others ?? [])], 'gives', 'give');
  if (f.type === 'lab_result' && limitAgainstMeasurement(f.value, m.p.value)) return `These documents give different values, and ${rec} a measurement where this gives only a limit`;
  return `These documents give different values, and ${rec} it in ${notComparedWhy(f.type, f.value, m.p.value)}`;
}

/** The same, with what the record gives: "...: 112 mg/dL on 2024-03-18." */
function notComparedDisagreeReason(f: MFact, m: Match): string {
  const ps = distinctReadings([m.p, ...(m.others ?? [])]).sort((a, b) => (a.value.num ?? Infinity) - (b.value.num ?? Infinity) || a.value.text.localeCompare(b.value.text));
  const values = ps.every((p) => !p.value.empty) && ps.length > 1 ? `${ps.map((p) => p.value.display).join(' or ')} on ${formatPartialDate(ps[0].date)}` : saysOf(ps[0]);
  return `${notComparedDisagreeHead(f, m)}: ${values}.`;
}

/** A reconciled detail that names nothing to match: what it lacks. */
const NO_SUBJECT_REASON: Record<ReconcileType, string> = {
  lab_result: 'Not compared: it does not name the test, so it cannot be matched with a clinical record.',
  imaging_result: 'Not compared: it does not say which scan it is (the kind of scan or the part of the body), so it cannot be matched with a clinical record.',
  vital: 'Not compared: it does not name the vital sign, so it cannot be matched with a clinical record.',
  procedure: 'Not compared: it does not name the procedure, so it cannot be matched with a clinical record.',
  event: 'Not compared: it does not say what happened, so it cannot be matched with a clinical record.',
};
/** A lab line that holds several tests ("OP 17; protein 52"): not compared, so one differing part never sets the line aside. */
export const SEVERAL_TESTS_REASON = 'Not compared: one line holds several tests.';
/** A reconciled detail with no date: never compared. */
export const NO_DATE_REASON = 'Not compared: it gives no date, so it cannot be matched with a clinical record.';

/**
 * One test's reading as the Labs page reads it (a part of a line of several tests, or a record's value), for
 * compareLabReading. Not the shared LabReading of src/shared/labvalues.ts (the full reading of a value as printed):
 * import this one as ReconcileLabReading.
 */
export interface ReconcileLabReading {
  /** The detail it was read from (a verified one for a record). */
  factId: string | null;
  /** The test's name ("CSF protein", "Opening pressure"). */
  analyte: string;
  /** Its key as the Labs page groups it (labs.ts normalizeAnalyte on its sample), for its name in the words. */
  analyteKey?: string | null;
  valueText: string | null;
  valueNum: number | null;
  unit: string | null;
  date: string | null;
}

/**
 * One test read out of a lab line that holds several (labs.ts checkLabParts), compared with the clinical records of its
 * test, sample and day (`records`: verified details' readings of that test, the caller matched the test, sample and
 * day). The pass's own comparison (relate: units that scale converted, a rougher number equal, answers in words) and
 * its own words: accurate when it matches a record ("Matches the lab report: …"), inaccurate when it differs from them
 * ("The lab report says …"), unbacked "Not compared: …" when no record can be compared with it (another unit, other
 * words); null when none of the records is a verified detail here. Read only: nothing is written, and the part is not
 * an event on the Reconciliation page (its line's detail is the one listed there).
 */
export function compareLabReading(part: ReconcileLabReading, records: ReconcileLabReading[]): TrustInfo | null {
  const M = getModel();
  const valueFor = (r: ReconcileLabReading): Value =>
    valueOf('lab_result', { analyte: r.analyte, value: r.valueText ?? (r.valueNum != null ? String(r.valueNum) : ''), value_num: r.valueNum, unit: r.unit ?? '' });
  const recs: MFact[] = [];
  for (const r of records) {
    const base = r.factId ? M.byId.get(r.factId) : undefined;
    if (!base || base.tier !== 'primary') continue;
    // The record's detail as it reads this one test (its line may hold several): its value, name and day.
    recs.push({ ...base, date: r.date ?? base.date, label: analyteLabel(r.analyteKey || normalizeAnalyte(r.analyte, null), r.analyte), value: valueFor(r) });
  }
  if (!recs.length) return null;
  const pv = valueFor(part);
  const extra = { byUser: false, eventKey: null, canSeparate: false };
  const same = recs.find((p) => sameValue('lab_result', pv, p.value));
  if (same) return { trust: 'accurate', ...recordFields(same), reason: matchesWords(same), ...extra };
  const diff = recs.filter((p) => differs('lab_result', pv, p.value));
  if (diff.length) return { trust: 'inaccurate', ...recordFields(diff[0]), reason: mismatchWords(diff.length > 1 ? { p: diff[0], same: false, near: false, others: diff.slice(1) } : { p: diff[0], same: false, near: false }, pv), ...extra };
  return { trust: 'unbacked', ...recordFields(recs[0]), reason: notComparedWithRecords('lab_result', pv, recs), ...extra };
}

/** The old name of ReconcileLabReading (labs.ts imports it by this name). */
export type LabReading = ReconcileLabReading;

/**
 * Would "Not the same event" (or "Both happened" on a record) change anything here? A clinical record in a
 * contest; a mention compared with a record on another day, or grouped with mentions of other days. Not on the
 * record's own day, not for a detail already marked, a correction, or one replaced.
 */
function canSeparateOf(f: MFact, L: Ledger, m: Match | null, ev: EventModel | null): boolean {
  if (f.separate || (f.status === 'superseded' && !L.active.has(f.id)) || isCorrection(f)) return false;
  if (f.tier === 'primary') return L.contestOf.has(f.id) || Boolean(L.restated.get(f.id) && !L.restated.get(f.id)!.notCompared);
  if (!isDay(f.date)) return false;
  if (m?.contest) return !m.contest.records.some((r) => r.date === f.date);
  if (m) return m.near || Boolean(m.resulted);
  if (ev && !ev.record && f.window) return ev.facts.some((x) => x.id !== f.id && x.date !== f.date);
  return false;
}

function deriveTrust(f: MFact, L: Ledger, m: Match | null, ev: EventModel | null): TrustInfo {
  return { ...baseTrust(f, L, m, ev), canSeparate: canSeparateOf(f, L, m, ev) };
}

function baseTrust(f: MFact, L: Ledger, m: Match | null, ev: EventModel | null): TrustInfo {
  const eventKey = ev?.listed ? ev.key : null;
  if (f.status === 'superseded' && !L.active.has(f.id)) return { trust: 'replaced', byUser: false, ...NO_RECORD, reason: 'Replaced by a newer reading or a merged duplicate.', eventKey: null };
  // What the mention is compared with: a verified detail (never a record in a contest, which settles nothing). A
  // record it could not be compared with (another unit, other words) is only named.
  const tm = m && !m.contest && !m.notCompared ? m : null;
  const nc = m?.notCompared ? m : null;
  const rec = tm ? recordFields(tm.p) : nc ? recordFields(nc.p) : NO_RECORD;
  if (f.tier === 'primary') {
    if (f.status === 'disputed') return { trust: 'inaccurate', byUser: true, ...rec, reason: 'You marked this wrong.', eventKey };
    // "Not sure" on a clinical record: it settles nothing until the user is sure.
    if (f.status === 'unverified' && f.verdictBasis === 'unsure') return { trust: 'unbacked', byUser: true, ...rec, reason: 'You were not sure about this one.', eventKey };
    const own = L.contestOf.get(f.id);
    if (own) return { trust: 'conflict', byUser: false, ...NO_RECORD, reason: contestReason(own), eventKey };
    const c = L.outranked.get(f.id);
    if (c) {
      if (isCorrection(f)) return { trust: 'inaccurate', byUser: true, ...recordFields(c), reason: `Your later correction says otherwise: ${noteOf(c)}`, eventKey };
      if (c.tier === 'primary') return { trust: 'inaccurate', byUser: true, ...recordFields(c), reason: `You said ${clip(c.documentTitle || 'another clinical record', 120)} is right${chosenTail(c)}`, eventKey };
      return { trust: 'inaccurate', byUser: true, ...recordFields(c), reason: `You said the record is wrong: ${noteOf(c)}`, eventKey };
    }
    // A clinic note (or another record) restating the report and saying something else: the report is the truth. A scan
    // worded otherwise than the scan report of its day: not compared, the report quoted.
    const restated = L.restated.get(f.id);
    if (restated?.notCompared) return { trust: 'unbacked', byUser: false, ...recordFields(restated.p), reason: notComparedReason(f, restated), eventKey };
    if (restated) return { trust: 'inaccurate', byUser: false, ...recordFields(restated.p), reason: mismatchWords(restated, f.value), eventKey };
    if (isCorrection(f)) return { trust: 'verified', byUser: true, ...recordFields(f), reason: `You said this record is right${chosenTail(f)}`, eventKey };
    if (f.separate) return { trust: 'verified', byUser: false, ...recordFields(f), reason: `From ${recordWords(f)}. You said this is another occasion.`, eventKey };
    return { trust: 'verified', byUser: false, ...recordFields(f), reason: `From ${recordWords(f)}.`, eventKey };
  }
  if (L.active.has(f.id) && tm) {
    // Set aside by the pass: a copy of the record, or a disagreement with it.
    return tm.same ? { trust: 'accurate', byUser: false, ...rec, reason: matchesWords(tm.p, tm), eventKey } : { trust: 'inaccurate', byUser: false, ...rec, reason: mismatchWords(tm, f.value), eventKey };
  }
  if (f.status === 'disputed') return { trust: 'inaccurate', byUser: true, ...rec, reason: tm ? `You marked this wrong. ${mismatchWords(tm, f.value)}` : 'You marked this wrong.', eventKey };
  if (f.status === 'confirmed') {
    if (isCorrection(f)) {
      const later = L.outranked.get(f.id);
      if (later) return { trust: 'inaccurate', byUser: true, ...recordFields(later), reason: `Your later correction says otherwise: ${noteOf(later)}`, eventKey };
      // The record of its day says nothing against it (it agrees, or it is in another unit): the user chose this value.
      if (L.chosen.has(f.id)) return { trust: 'accurate', byUser: true, ...NO_RECORD, reason: `You said this value is right: ${noteOf(f)}`, eventKey, chosenValue: true };
      return { trust: 'accurate', byUser: true, ...NO_RECORD, reason: `You corrected the record: ${noteOf(f)}`, eventKey };
    }
    if (f.verdictBasis === 'summary') return { trust: 'unbacked', byUser: true, ...rec, reason: 'You marked it as seen only in a summary.', eventKey };
    // Kept although it differs from the record: the user's word stands, and what the record says stays in view.
    return { trust: 'accurate', byUser: true, ...rec, reason: tm && !tm.same ? `You said this is accurate. ${mismatchWords(tm, f.value)}` : 'You said this is accurate.', eventKey };
  }
  if (f.status === 'unverified' && f.verdictBasis === 'unsure') return { trust: 'unbacked', byUser: true, ...rec, reason: 'You were not sure about this one.', eventKey };
  if (tm) return tm.same ? { trust: 'accurate', byUser: false, ...rec, reason: matchesWords(tm.p, tm), eventKey } : { trust: 'inaccurate', byUser: false, ...rec, reason: mismatchWords(tm, f.value), eventKey };
  // A line that holds several tests is not compared (only the same line written the same is a copy, above).
  if (f.value.several) return { trust: 'unbacked', byUser: false, ...NO_RECORD, reason: SEVERAL_TESTS_REASON, eventKey };
  // Clinical records disagree about its event: neither accurate nor inaccurate until the user settles it.
  const contest = m?.contest ?? ev?.contest ?? null;
  if (contest) return { trust: 'conflict', byUser: false, ...NO_RECORD, reason: contestReason(contest), eventKey };
  // Values the record of their day could not be compared with that disagree with each other: a disagreement, the record named.
  if (nc && ev?.state === 'needs_source') return { trust: 'conflict', byUser: false, ...rec, reason: notComparedDisagreeReason(f, nc), eventKey };
  if (ev?.state === 'needs_source') return { trust: 'conflict', byUser: false, ...NO_RECORD, reason: 'Other documents give a different date or value, and no clinical record settles it yet.', eventKey };
  if (f.separate) return { trust: 'unbacked', byUser: true, ...NO_RECORD, reason: 'You said this is another occasion.', eventKey };
  // A record is there, but this cannot be compared with it: said plainly, with what the record gives.
  if (nc) return { trust: 'unbacked', byUser: false, ...rec, reason: notComparedReason(f, nc), eventKey };
  // Nothing it could ever be matched with: no subject, or no date. Adding a record would not check it either.
  if (!f.key) return { trust: 'unbacked', byUser: false, ...NO_RECORD, reason: NO_SUBJECT_REASON[f.type] ?? NO_SUBJECT_REASON.event, eventKey };
  if (!f.date || !(isDay(f.date) || isCoarse(f.date))) return { trust: 'unbacked', byUser: false, ...NO_RECORD, reason: NO_DATE_REASON, eventKey };
  return { trust: 'unbacked', byUser: false, ...NO_RECORD, reason: null, eventKey };
}

/** The fields trust is derived from, for a detail outside the reconciled ledger (or any row already loaded). */
export interface TrustRow {
  id: string;
  status: string;
  verdictBasis: string | null;
  verdictNote?: string | null;
  /** The source document's tier; null for a detail entered by hand without a document. */
  documentTier: string | null;
  deletedAt?: string | null;
}

/** Trust from the status, the user's check and the tier alone (details the reconciliation does not compare). */
export function plainTrust(r: TrustRow): TrustInfo {
  const base = { ...NO_RECORD, eventKey: null };
  if (r.deletedAt) return { ...base, trust: 'replaced', byUser: false, reason: 'Deleted.' };
  if (r.status === 'superseded') return { ...base, trust: 'replaced', byUser: false, reason: 'Replaced by a newer reading or a merged duplicate.' };
  if (r.status === 'disputed') return { ...base, trust: 'inaccurate', byUser: true, reason: 'You marked this wrong.' };
  // "Not sure" outranks the tier: a clinical record's detail the user is not sure of is not verified.
  if (r.status === 'unverified' && r.verdictBasis === 'unsure') return { ...base, trust: 'unbacked', byUser: true, reason: 'You were not sure about this one.' };
  if (r.documentTier === 'primary') return { ...base, trust: 'verified', byUser: false, reason: 'From the clinical record.' };
  if (r.status === 'confirmed') {
    if (r.verdictBasis === 'correction') return { ...base, trust: 'accurate', byUser: true, reason: `You corrected the record: ${clip(r.verdictNote ?? '', 300) || 'no reason given'}` };
    if (r.verdictBasis === 'summary') return { ...base, trust: 'unbacked', byUser: true, reason: 'You marked it as seen only in a summary.' };
    return { ...base, trust: 'accurate', byUser: true, reason: 'You said this is accurate.' };
  }
  if (r.verdictBasis === 'unsure') return { ...base, trust: 'unbacked', byUser: true, reason: 'You were not sure about this one.' };
  return { ...base, trust: 'unbacked', byUser: false, reason: NOT_COMPARED_REASON };
}

/** Why a detail outside the reconciled ledger (a diagnosis, a medication, a statement; one typed by hand) is never checked. */
export const NOT_COMPARED_REASON = 'Not compared automatically: only lab results, scans, vital signs, procedures and events from documents are compared with the clinical records.';

/** Trust for rows already loaded (the facts list): the reconciled ledger's word for its facts, else plainTrust. */
export function trustForRows(rows: TrustRow[]): Map<string, TrustInfo> {
  const out = new Map<string, TrustInfo>();
  if (!rows.length) return out;
  const M = getModel();
  const rest = rows.filter((r) => r.deletedAt || !M.trust.get(r.id));
  const voices = passageVoices(rest.map((r) => r.id));
  for (const r of rows) {
    const t = !r.deletedAt ? M.trust.get(r.id) : undefined;
    if (t) {
      out.set(r.id, t);
      continue;
    }
    const v = voices.get(r.id);
    out.set(r.id, plainTrust(v ? { ...r, documentTier: factTier(r.documentTier, v) } : r));
  }
  return out;
}

/**
 * The voice of each fact (asserted_by and its passage link), for trust that follows the passage (2026-10-07): a
 * patient's own words inside a clinical record are not "from the clinical record". One query per 500 ids.
 */
function passageVoices(ids: string[]): Map<string, { assertedBy: string | null; attributesJson: string }> {
  const out = new Map<string, { assertedBy: string | null; attributesJson: string }>();
  const want = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < want.length; i += 500) {
    for (const r of db()
      .select({ id: schema.facts.id, assertedBy: schema.facts.assertedBy, attributesJson: schema.facts.attributesJson })
      .from(schema.facts)
      .where(inArray(schema.facts.id, want.slice(i, i + 500)))
      .all())
      out.set(r.id, { assertedBy: r.assertedBy, attributesJson: r.attributesJson });
  }
  return out;
}

/** Trust for these facts (any type), in one or two queries. Unknown ids are left out. */
export function trustFor(factIds: string[]): Map<string, TrustInfo> {
  const out = new Map<string, TrustInfo>();
  const ids = [...new Set(factIds.filter(Boolean))];
  if (!ids.length) return out;
  const M = getModel();
  const rest: string[] = [];
  for (const id of ids) {
    const t = M.trust.get(id);
    if (t) out.set(id, t);
    else rest.push(id);
  }
  const f = schema.facts;
  for (let i = 0; i < rest.length; i += 500) {
    const rows = db()
      .select({ id: f.id, status: f.status, verdictBasis: f.verdictBasis, verdictNote: f.verdictNote, deletedAt: f.deletedAt, documentTier: schema.documents.sourceTier, documentDeletedAt: schema.documents.deletedAt, assertedBy: f.assertedBy, attributesJson: f.attributesJson })
      .from(f)
      .leftJoin(schema.documents, eq(schema.documents.id, f.sourceDocumentId))
      .where(inArray(f.id, rest.slice(i, i + 500)))
      .all();
    // Trust follows the passage: the patient's own words inside a clinical record are his, not the record's.
    for (const r of rows) out.set(r.id, plainTrust({ ...r, documentTier: r.documentTier === null ? null : factTier(r.documentTier, r), deletedAt: r.deletedAt ?? r.documentDeletedAt }));
  }
  return out;
}

/** Ids of reconciled facts (types in RECONCILED_TYPES, of a live document) whose trust is this one: for the facts list's trust filter. */
export function reconciledIdsWithTrust(trust: string): string[] {
  const M = getModel();
  const out: string[] = [];
  for (const [id, t] of M.trust) if (t.trust === trust) out.push(id);
  return out;
}

export function reconcileCounts(): ReconcileCounts {
  return { ...getModel().counts };
}

interface CiteLite {
  id: string;
  pageNumber: number;
}

function firstCitations(ids: string[]): Map<string, CiteLite> {
  const out = new Map<string, CiteLite>();
  if (!ids.length) return out;
  const c = schema.citations;
  for (let i = 0; i < ids.length; i += 400) {
    const rows = db()
      .select({ id: c.id, factId: c.factId, pageNumber: c.pageNumber, verified: c.verified, createdAt: c.createdAt })
      .from(c)
      .where(inArray(c.factId, ids.slice(i, i + 400)))
      .all()
      .sort((x, y) => Number(y.verified) - Number(x.verified) || x.pageNumber - y.pageNumber || x.createdAt.localeCompare(y.createdAt));
    for (const r of rows) if (r.factId && !out.has(r.factId)) out.set(r.factId, { id: r.id, pageNumber: r.pageNumber });
  }
  return out;
}

function mentionOf(f: MFact, M: Model, cites: Map<string, CiteLite>): Mention {
  const c = cites.get(f.id);
  return {
    factId: f.id,
    documentId: f.documentId,
    documentTitle: f.documentTitle,
    documentTier: f.tier,
    page: c?.pageNumber ?? null,
    citationId: c?.id ?? null,
    date: f.date,
    datePrecision: f.datePrecision,
    dateText: f.dateText,
    says: saysOf(f),
    statement: f.statement,
    trust: M.trust.get(f.id) ?? plainTrust({ id: f.id, status: f.status, verdictBasis: f.verdictBasis, verdictNote: f.verdictNote, documentTier: f.tier }),
  };
}

function eventHay(ev: EventModel): string {
  ev.hay ??= [ev.subject, ev.dateLabel, ev.type.replace('_', ' '), ...ev.facts.flatMap((f) => [f.statement, f.documentTitle, saysOf(f), f.dateText ?? ''])].join('\n').toLowerCase();
  return ev.hay;
}

function toEvent(ev: EventModel, M: Model, cites: Map<string, CiteLite>): ReconcileEvent {
  const others = ev.facts.filter((f) => f !== ev.record);
  const groups = new Map<string, { says: string; mentions: Mention[] }>();
  for (const f of others) {
    const k = `${f.date ?? ''}\u001f${valueKey(f.value)}`;
    const g = groups.get(k);
    const m = mentionOf(f, M, cites);
    if (g) g.mentions.push(m);
    else groups.set(k, { says: m.says, mentions: [m] });
  }
  return {
    key: ev.key,
    type: ev.type,
    subject: ev.subject,
    dateLabel: ev.dateLabel,
    state: ev.state,
    record: ev.record ? mentionOf(ev.record, M, cites) : null,
    groups: [...groups.values()].sort((a, b) => b.mentions.length - a.mentions.length || a.says.localeCompare(b.says)),
    mentionCount: ev.facts.length,
    documentCount: new Set(ev.facts.map((f) => f.documentId)).size,
    recordsDisagree: ev.contest !== null,
    reason: ev.reason,
  };
}

export interface ListOptions {
  q?: string;
  limit?: number;
  offset?: number;
}

function page<T>(list: T[], opts: ListOptions): T[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const offset = Math.max(0, opts.offset ?? 0);
  return list.slice(offset, offset + limit);
}

/** Events in one state (needs_source | settled | unbacked), newest first, with every mention grouped by what it says. */
export function listReconcileEvents(state: ReconcileState, opts: ListOptions = {}): { items: ReconcileEvent[]; total: number } {
  const M = getModel();
  const q = (opts.q ?? '').trim().toLowerCase();
  const all = M.events.filter((e) => e.state === state && (!q || eventHay(e).includes(q)));
  const items = page(all, opts);
  const cites = firstCitations(items.flatMap((e) => e.facts.map((f) => f.id)));
  return { items: items.map((e) => toEvent(e, M, cites)), total: all.length };
}

/** One event by its key (any state), or null. */
export function getReconcileEvent(key: string): ReconcileEvent | null {
  const M = getModel();
  const ev = M.events.find((e) => e.key === key);
  if (!ev) return null;
  return toEvent(ev, M, firstCitations(ev.facts.map((f) => f.id)));
}

/** Every inaccurate detail, newest first: what it says, what the record says, and its event. */
export function listInaccurate(opts: ListOptions = {}): { items: InaccurateItem[]; total: number } {
  const M = getModel();
  const q = (opts.q ?? '').trim().toLowerCase();
  const all = M.inaccurate.filter((f) => {
    if (!q) return true;
    const ev = M.eventOf.get(f.id);
    return [f.statement, f.documentTitle, saysOf(f), subjectLabel(f), ev?.subject ?? '', ev?.dateLabel ?? '', M.trust.get(f.id)?.reason ?? ''].join('\n').toLowerCase().includes(q);
  });
  const items = page(all, opts);
  const recordOf = (f: MFact): MFact | null => {
    const t = M.trust.get(f.id);
    return t?.recordFactId && t.recordFactId !== f.id ? (M.byId.get(t.recordFactId) ?? null) : null;
  };
  const cites = firstCitations(items.flatMap((f) => [f.id, recordOf(f)?.id ?? '']).filter(Boolean));
  return {
    total: all.length,
    items: items.map((f) => {
      const ev = M.eventOf.get(f.id);
      const rec = recordOf(f);
      return {
        ...mentionOf(f, M, cites),
        record: rec ? mentionOf(rec, M, cites) : null,
        event: ev?.listed ? { key: ev.key, subject: ev.subject, dateLabel: ev.dateLabel } : { key: '', subject: subjectLabel(f), dateLabel: f.date ? `on ${formatPartialDate(f.date)}` : 'no date given' },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// The user's answers
// ---------------------------------------------------------------------------

/** A live detail of a reconciled type, or 404 / 400. */
function reconciledFact(factId: string): typeof schema.facts.$inferSelect {
  const f = db().select().from(schema.facts).where(and(eq(schema.facts.id, factId), isNull(schema.facts.deletedAt))).get();
  if (!f) throw notFound('detail not found');
  if (!isReconciledType(f.type)) throw badRequest('only lab results, scans, vital signs, procedures and events are reconciled');
  return f;
}

/** Not for a detail a newer reading or a merge by hand replaced: that is changed where it was decided. */
function refuseReplaced(f: typeof schema.facts.$inferSelect): void {
  if (f.status === 'superseded' && !passSetAsideIds([f.id]).has(f.id)) throw conflict('this detail was replaced by a newer reading or a merged duplicate; open it to change that');
}

/** Write private bookkeeping keys into a fact's attributes (never its clinical attributes). */
function writePrivate(factId: string, patch: Record<string, unknown>): void {
  const row = db().select({ attributesJson: schema.facts.attributesJson }).from(schema.facts).where(eq(schema.facts.id, factId)).get();
  if (!row) return;
  const a = parseJson<Record<string, unknown>>(row.attributesJson, {});
  for (const [k, v] of Object.entries(patch)) {
    if (!k.startsWith('_')) continue;
    if (v === undefined) delete a[k];
    else a[k] = v;
  }
  db().update(schema.facts).set({ attributesJson: JSON.stringify(a), updatedAt: nowIso() }).where(eq(schema.facts.id, factId)).run();
}

export interface MentionAnswer {
  factId: string;
  trust: TrustInfo;
  counts: ReconcileCounts;
}

function answer(factId: string): MentionAnswer {
  return { factId, trust: trustFor([factId]).get(factId)!, counts: reconcileCounts() };
}

/**
 * "This is the official record": the document becomes a clinical record (source
 * tier primary) through the documents service, whose tier hook runs the pass,
 * so every mention of what it records is settled at once.
 */
export function markOfficial(documentId: string, by: string | null): { documentId: string; changed: boolean; counts: ReconcileCounts } {
  const doc = db().select().from(schema.documents).where(and(eq(schema.documents.id, documentId), isNull(schema.documents.deletedAt))).get();
  if (!doc) throw notFound('document not found');
  const changed = doc.sourceTier !== 'primary';
  if (changed) updateDocument(documentId, { sourceTier: 'primary' });
  const meta = parseJson<Record<string, unknown>>(db().select({ m: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get()?.m, {});
  meta.official = { by, at: nowIso() };
  db().update(schema.documents).set({ metadataJson: JSON.stringify(meta) }).where(eq(schema.documents.id, documentId)).run();
  if (!changed) reconcileAll({ documentId, trigger: 'official' });
  return { documentId, changed, counts: reconcileCounts() };
}

/**
 * "The record is wrong": the patient's own word corrects a clinical inaccuracy.
 * The mention becomes the truth for its event (confirmed, basis `correction`,
 * the reason as its note); the record's conflicting fact (on the correction's
 * own day the ones that say otherwise, else the nearest within the window) is
 * shown inaccurate with the reason but never set aside or changed; the other
 * mentions compare with the correction.
 *
 * On a clinical record this is "This one is right" (two records disagree): the
 * reason may be left out (RECORD_CHOSEN_NOTE is kept), the record stays the
 * verified truth and the record that disagrees reads inaccurate.
 *
 * A note the user wrote before is kept: the note becomes the reason, a blank
 * line, then "Earlier note: <the note>", and Back to automatic puts the earlier
 * note back (`_priorNote`, `_correctionNote`, `_correctionReason` in the fact's
 * private attributes).
 */
export function correctRecord(factId: string, reason: string | null | undefined, by: string | null): MentionAnswer {
  const f = reconciledFact(factId);
  const tier = f.sourceDocumentId ? (db().select({ t: schema.documents.sourceTier }).from(schema.documents).where(eq(schema.documents.id, f.sourceDocumentId)).get()?.t ?? null) : null;
  let why = (reason ?? '').trim();
  if (!why && tier === 'primary') why = RECORD_CHOSEN_NOTE;
  if (!why || why.length > 1000) throw badRequest('a reason (1 to 1000 characters) is required');
  refuseReplaced(f);
  if (!f.date || f.date.length !== 10) throw badRequest('only a detail with a full date can stand for an event');
  const a = parseJson<Record<string, unknown>>(f.attributesJson, {});
  if (!subjectOf(f.type, a).key) throw badRequest('this detail does not say what it is about, so it cannot stand for an event');
  // What the user wrote before this correction: the note there now, or (a correction made again, its note
  // untouched since) the note kept from before the first one.
  const current = (f.verdictNote ?? '').trim();
  const wasCorrection = f.status === 'confirmed' && f.verdictBasis === 'correction';
  const untouched = wasCorrection && typeof a._correctionNote === 'string' && current === a._correctionNote;
  const earlier = untouched ? (typeof a._priorNote === 'string' ? a._priorNote : '') : current;
  const note = (earlier && earlier !== why ? `${why}\n\nEarlier note: ${earlier}` : why).trim();
  const now = nowIso();
  setVerdict(factId, 'confirmed', note, 'correction', { reconcile: false });
  writePrivate(factId, {
    _correctedBy: by,
    _correctedAt: now,
    _correctionReason: why,
    _correctionNote: note,
    _priorNote: earlier || undefined,
    // A correction made again over an earlier one: the earlier reason is kept, never thrown away.
    ...(untouched && typeof a._correctionReason === 'string' && a._correctionReason !== why ? { _previousCorrection: { reason: a._correctionReason, at: a._correctedAt ?? null, by: a._correctedBy ?? null } } : {}),
  });
  reconcileAll({ trigger: 'correction' });
  return answer(factId);
}

/**
 * "Not the same event": the mention is compared on its own date only, from now on. On a clinical record whose
 * event other records disagree with, "Both happened": it is its own occasion (its own reading that day, for a lab
 * or a vital). Refused (409) for a lab result or vital sign on the same day as the record it is compared with:
 * that would change nothing (two readings the same day are told apart on the record, with Both happened).
 */
export function separateMention(factId: string, by: string | null): MentionAnswer {
  const f = reconciledFact(factId);
  refuseReplaced(f);
  const M = getModel();
  const self = M.byId.get(factId);
  const m = M.match.get(factId);
  if (self && self.tier !== 'primary' && (self.type === 'lab_result' || self.type === 'vital') && m && isDay(self.date) && m.p.date === self.date) {
    throw conflict('This is the same day as the clinical record, so it cannot be another occasion. If it is wrong, say so; if it is right, use It\'s actually right.');
  }
  writePrivate(factId, { [SEPARATE_MARKER]: true, _reconcileSeparateBy: by, _reconcileSeparateAt: nowIso() });
  reconcileAll({ trigger: 'verdict' });
  return answer(factId);
}

/** "It's actually right": the user's word (Accurate, checked against the original), which takes back the pass's link. */
export function keepMention(factId: string, by: string | null): MentionAnswer {
  const f = reconciledFact(factId);
  refuseReplaced(f);
  const t = trustFor([factId]).get(factId);
  const M = getModel();
  const self = M.byId.get(factId);
  if (M.contested.has(factId)) {
    // Two clinical records disagree: saying one is accurate does not choose between them.
    throw conflict('Two clinical records disagree here. Use This one is right on the record that is right, or Both happened if both are real.');
  }
  const rec = t?.recordFactId && t.recordFactId !== factId ? M.byId.get(t.recordFactId) : undefined;
  if (t?.trust === 'inaccurate' && t.byUser && f.status !== 'disputed' && self && rec && isCorrection(rec) && (self.tier === 'primary' || isCorrection(self))) {
    // The user's own correction (or choice of another record) says this is wrong: that is what to undo.
    if (rec.tier === 'primary') throw conflict('you chose the other clinical record as the right one; put that choice back to automatic instead');
    throw conflict('your correction says this is wrong; put that correction back to automatic instead');
  }
  setVerdict(factId, 'confirmed', undefined, 'original', { reconcile: false });
  writePrivate(factId, { _keptBy: by, _keptAt: nowIso() });
  reconcileAll({ trigger: 'verdict' });
  return answer(factId);
}

/**
 * Back to automatic: pending with no check, no longer "not the same event",
 * and the pass may set it aside again (a link the user took back reads as one
 * the pass undid). The note stays, except that undoing a correction whose note
 * is still the one the correction wrote puts back the note from before it (the
 * withdrawn reason is kept in `_withdrawnCorrection`); with no earlier note the
 * reason stays as the note.
 */
export function resetMention(factId: string, by: string | null): MentionAnswer {
  const f = reconciledFact(factId);
  refuseReplaced(f);
  const a = parseJson<Record<string, unknown>>(f.attributesJson, {});
  const now = nowIso();
  const wasCorrection = f.status === 'confirmed' && f.verdictBasis === 'correction';
  const untouched = wasCorrection && typeof a._correctionNote === 'string' && (f.verdictNote ?? '').trim() === a._correctionNote;
  const prior = untouched && typeof a._priorNote === 'string' && a._priorNote.trim() ? a._priorNote : undefined;
  // "This record is right." is the app's own words for a record chosen without a reason, not the user's note: with
  // nothing written before, it goes with the choice.
  const appWords = untouched && prior === undefined && a._correctionNote === RECORD_CHOSEN_NOTE;
  setVerdict(factId, 'unverified', prior !== undefined ? prior : appWords ? null : undefined, null, { reconcile: false });
  db().update(schema.factMerges).set({ reason: CLINICAL_RECORD_REASON }).where(and(eq(schema.factMerges.reason, CLINICAL_RECORD_TAKEN_BACK), eq(schema.factMerges.factIdB, factId))).run();
  writePrivate(factId, {
    [SEPARATE_MARKER]: undefined,
    _reconcileSeparateBy: undefined,
    _reconcileSeparateAt: undefined,
    _correctedBy: undefined,
    _correctedAt: undefined,
    _correctionReason: undefined,
    _correctionNote: undefined,
    _priorNote: undefined,
    _keptBy: undefined,
    _keptAt: undefined,
    _resetBy: by,
    _resetAt: now,
    ...(untouched ? { _withdrawnCorrection: { reason: typeof a._correctionReason === 'string' ? a._correctionReason : null, at: now, by } } : {}),
  });
  reconcileAll({ trigger: 'verdict' });
  return answer(factId);
}
