/**
 * Imaging studies: one row per study with modality, body part, impression,
 * findings, the report it came from, and any DICOM documents that hold the
 * images. Like labs, extracted `imaging_result` facts that have not been
 * imported appear as virtual entries (`fact:<factId>`) so the ledger is
 * complete before anyone presses "from facts". Two studies can be compared
 * word by word (`wordDiff`) so a change between reports stands out.
 */
import { z } from 'zod';
import { and, asc, desc, eq, getTableColumns, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { newId, normalizeKey, nowIso, parseJson } from '../util/ids';
import { badRequest, conflict, notFound, parseOrThrow } from '../util/errors';
import { indexEntity, removeEntityIndex } from './search';
import { resolveInstitutionId } from './records';
import { trustFor } from './reconcile';
import type { TrustInfo } from '../../shared/reconcile';
import { IMAGING_MODALITIES } from '../../shared/enums';
import { dateSortKey, parsePartialDate } from '../../shared/dates';

// ---------------------------------------------------------------------------
// Modality
// ---------------------------------------------------------------------------

const MODALITY_ALIAS: Record<string, string> = {
  mri: 'MRI', mr: 'MRI', 'magnetic resonance': 'MRI', 'magnetic resonance imaging': 'MRI', mra: 'MRI', mrv: 'MRI', fmri: 'MRI',
  ct: 'CT', 'cat scan': 'CT', 'computed tomography': 'CT', cta: 'CT', ctv: 'CT',
  pet: 'PET', 'fdg pet': 'PET', 'fdg pet brain': 'PET',
  'pet ct': 'PET-CT', 'fdg pet ct': 'PET-CT', petct: 'PET-CT',
  'pet mri': 'PET-MRI', 'pet mr': 'PET-MRI', petmri: 'PET-MRI',
  spect: 'SPECT', 'dat scan': 'SPECT', datscan: 'SPECT',
  xr: 'XR', 'x ray': 'XR', xray: 'XR', radiograph: 'XR', 'plain film': 'XR', cxr: 'XR',
  us: 'US', ultrasound: 'US', sonogram: 'US', sonography: 'US', doppler: 'US', echo: 'US', echocardiogram: 'US',
  eeg: 'EEG', electroencephalogram: 'EEG', 'video eeg': 'EEG', veeg: 'EEG',
  emg: 'EMG', electromyography: 'EMG', 'emg ncs': 'EMG',
  ncs: 'NCS', 'nerve conduction': 'NCS', 'nerve conduction study': 'NCS', 'nerve conduction studies': 'NCS',
};

/** Fold a modality as written into one of IMAGING_MODALITIES, else 'other'. */
export function canonicalModality(s: string | null | undefined): string {
  const k = normalizeKey(s);
  if (!k) return 'other';
  const direct = MODALITY_ALIAS[k];
  if (direct) return direct;
  const toks = k.split(' ');
  const has = (t: string) => toks.includes(t);
  if (has('pet') && (has('ct') || has('mri') || has('mr'))) return has('ct') ? 'PET-CT' : 'PET-MRI';
  if (has('pet')) return 'PET';
  if (has('mri') || has('mr') || has('mra') || has('mrv')) return 'MRI';
  if (has('ct') || has('cta')) return 'CT';
  if (has('spect')) return 'SPECT';
  if (has('eeg')) return 'EEG';
  if (has('emg')) return 'EMG';
  if (has('ncs')) return 'NCS';
  if (has('ultrasound') || has('us')) return 'US';
  if (has('xr') || has('xray') || (has('x') && has('ray'))) return 'XR';
  const upper = (s ?? '').trim().toUpperCase();
  return (IMAGING_MODALITIES as readonly string[]).includes(upper) ? upper : 'other';
}

// ---------------------------------------------------------------------------
// Body part
// ---------------------------------------------------------------------------

const BODY_PART_RULES: Array<{ re: RegExp; key: string; label: string }> = [
  { re: /\b(brain|head|cranial|intracranial|cerebr|skull)\b/, key: 'brain', label: 'Brain' },
  { re: /\b(pituitary|sella|hypophys)\b/, key: 'pituitary', label: 'Pituitary' },
  { re: /\borbits?\b/, key: 'orbits', label: 'Orbits' },
  { re: /\b(iac|internal auditory|temporal bones?)\b/, key: 'temporal bones', label: 'Temporal bones' },
  { re: /\b(neck|soft tissue neck|carotid)\b/, key: 'neck', label: 'Neck' },
  { re: /\b(chest|thorax|thoracic cavity|lungs?|pulmonary)\b/, key: 'chest', label: 'Chest' },
  { re: /\b(heart|cardiac)\b/, key: 'heart', label: 'Heart' },
  { re: /\b(whole body|total body|entire body|skull to thigh|skull base to mid thigh)\b/, key: 'whole body', label: 'Whole body' },
  { re: /\b(upper (limb|extremit)|arm|forearm|hand|wrist|elbow|shoulder)\b/, key: 'upper limb', label: 'Upper limb' },
  { re: /\b(lower (limb|extremit)|leg|thigh|foot|feet|ankle|knee|hip)\b/, key: 'lower limb', label: 'Lower limb' },
];
const SPINE_SEGMENTS: Array<{ re: RegExp; key: string; label: string }> = [
  { re: /\b(cervical|c spine|cspine|c 1|c1)\b/, key: 'cervical spine', label: 'Cervical spine' },
  { re: /\b(thoracic|t spine|tspine)\b/, key: 'thoracic spine', label: 'Thoracic spine' },
  { re: /\b(lumbar|lumbosacral|l spine|lspine|ls spine|lsspine|sacr)\b/, key: 'lumbar spine', label: 'Lumbar spine' },
];

/**
 * Fold a body part as written into a grouping key and label, so "MRI brain
 * w/wo", "Brain MRI" and "CT head" share one header and serial studies line
 * up. Unknown parts keep their normalised text; empty is "unspecified".
 */
export function normalizeBodyPart(s: string | null | undefined): { key: string; label: string } {
  const k = normalizeKey(s);
  if (!k) return { key: '', label: 'Unspecified' };
  if (/\bspine\b|\bspinal\b|vertebr|\bcervical\b|\bthoracic\b|\blumbar\b|lumbosacral|\bc spine\b|\bt spine\b|\bl spine\b|\bls spine\b/.test(k)) {
    const segs = SPINE_SEGMENTS.filter((r) => r.re.test(k));
    if (/\b(whole|total|entire|complete|full)\b/.test(k) || segs.length > 1) return { key: 'spine', label: segs.length > 1 ? 'Spine (several segments)' : 'Whole spine' };
    if (segs.length === 1) return { key: segs[0].key, label: segs[0].label };
    return { key: 'spine', label: 'Spine' };
  }
  const abdomen = /\b(abdomen|abdominal|abd)\b/.test(k);
  const pelvis = /\bpelvi[sc]\b/.test(k);
  if (abdomen && pelvis) return { key: 'abdomen and pelvis', label: 'Abdomen and pelvis' };
  if (abdomen) return { key: 'abdomen', label: 'Abdomen' };
  if (pelvis) return { key: 'pelvis', label: 'Pelvis' };
  for (const r of BODY_PART_RULES) if (r.re.test(k)) return { key: r.key, label: r.label };
  return { key: k, label: k.charAt(0).toUpperCase() + k.slice(1) };
}

// ---------------------------------------------------------------------------
// Word diff
// ---------------------------------------------------------------------------

export interface DiffSegment {
  kind: 'same' | 'add' | 'del';
  text: string;
}

interface Tok {
  raw: string;
  key: string;
}

function tokenize(s: string | null | undefined): Tok[] {
  return (s ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => {
      const key = raw.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      return { raw, key: key || raw };
    });
}

/**
 * Word-level diff from `oldText` to `newText` (longest common subsequence;
 * words compare case-insensitively ignoring punctuation). Consecutive words
 * of the same kind are joined into one segment.
 */
export function wordDiff(oldText: string | null | undefined, newText: string | null | undefined): DiffSegment[] {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const out: DiffSegment[] = [];
  const push = (kind: DiffSegment['kind'], raw: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += ` ${raw}`;
    else out.push({ kind, text: raw });
  };
  if (!a.length && !b.length) return out;
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    if (a.length) out.push({ kind: 'del', text: a.map((t) => t.raw).join(' ') });
    if (b.length) out.push({ kind: 'add', text: b.map((t) => t.raw).join(' ') });
    return out;
  }
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i].key === b[j].key ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].key === b[j].key) {
      push('same', b[j].raw);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      push('del', a[i].raw);
      i++;
    } else {
      push('add', b[j].raw);
      j++;
    }
  }
  for (; i < n; i++) push('del', a[i].raw);
  for (; j < m; j++) push('add', b[j].raw);
  return out;
}

export function diffStats(segments: DiffSegment[]): { same: number; added: number; removed: number } {
  const count = (s: DiffSegment) => s.text.split(/\s+/).filter(Boolean).length;
  let same = 0;
  let added = 0;
  let removed = 0;
  for (const s of segments) {
    if (s.kind === 'same') same += count(s);
    else if (s.kind === 'add') added += count(s);
    else removed += count(s);
  }
  return { same, added, removed };
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export type ImagingRow = typeof schema.imagingStudies.$inferSelect;
export type ImagingInsert = typeof schema.imagingStudies.$inferInsert;

export interface ImagingEntry {
  id: string;
  source: 'row' | 'fact';
  studyId: string | null;
  factId: string | null;
  modality: string;
  bodyPart: string | null;
  title: string;
  performedAt: string | null;
  performedAtPrecision: string;
  performedAtText: string | null;
  institutionId: string | null;
  institutionName: string | null;
  impression: string | null;
  findings: string | null;
  contrast: string | null;
  documentId: string | null;
  documentTitle: string | null;
  pageNumber: number | null;
  citationId: string | null;
  citationVerified: boolean | null;
  quote: string | null;
  factStatus: string | null;
  /** How a confirmed fact was checked: against the original record, or only against a summary. Null otherwise. */
  factBasis: 'original' | 'summary' | 'unsure' | 'correction' | null;
  factStatement: string | null;
  /**
   * The row was imported from a fact that has since been deleted in the Facts
   * ledger: still listed, never labelled as entered by hand, and not numbered
   * among the serial studies.
   */
  factDeleted: boolean;
  /** The automatic trust level of the fact behind the study (services/reconcile.ts); null for a study entered by hand. */
  trust: TrustInfo | null;
  hasImages: boolean;
  dicomDocumentIds: string[];
  dicomCount: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentLite {
  id: string;
  title: string;
  kind: string;
  documentDate: string | null;
}

export interface ImagingDetail extends ImagingEntry {
  dicomDocuments: DocumentLite[];
  /** Other studies to compare with, same modality first, newest first. */
  compareCandidates: Array<{ id: string; title: string; modality: string; performedAt: string | null; performedAtPrecision: string }>;
}

interface CiteLite {
  id: string;
  documentId: string;
  pageNumber: number;
  verified: boolean;
  quote: string;
}

function firstCitations(factIds: string[]): Map<string, CiteLite> {
  const out = new Map<string, CiteLite>();
  const ids = [...new Set(factIds.filter(Boolean))];
  if (!ids.length) return out;
  const c = schema.citations;
  for (let i = 0; i < ids.length; i += 400) {
    const rows = db()
      .select({ id: c.id, factId: c.factId, documentId: c.documentId, pageNumber: c.pageNumber, verified: c.verified, quote: c.quote })
      .from(c)
      .where(inArray(c.factId, ids.slice(i, i + 400)))
      .orderBy(desc(c.verified), asc(c.pageNumber), asc(c.createdAt))
      .all();
    for (const r of rows) if (r.factId && !out.has(r.factId)) out.set(r.factId, { id: r.id, documentId: r.documentId, pageNumber: r.pageNumber, verified: Boolean(r.verified), quote: r.quote });
  }
  return out;
}

interface ImagingAttrs {
  modality?: string | null;
  body_part?: string | null;
  contrast?: string | null;
  impression?: string | null;
  finding?: string | null;
  institution?: string | null;
  comparison?: string | null;
}

/** The verdict basis as the API reports it: only a confirmed fact carries one. */
function basisOf(status: string | null | undefined, basis: string | null | undefined): 'original' | 'summary' | 'unsure' | 'correction' | null {
  if (status === 'unverified') return basis === 'unsure' ? 'unsure' : null;
  if (status !== 'confirmed') return null;
  return basis === 'original' || basis === 'summary' || basis === 'correction' ? basis : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function byDateDesc(a: ImagingEntry, b: ImagingEntry): number {
  return dateSortKey(b.performedAt).localeCompare(dateSortKey(a.performedAt)) || b.createdAt.localeCompare(a.createdAt);
}

/**
 * Set aside by the user's verdict: the fact behind the study was disputed,
 * superseded (a newer reading or the kept duplicate replaces it) or deleted.
 */
export function isSetAside(e: Pick<ImagingEntry, 'factStatus' | 'factDeleted'>): boolean {
  return e.factStatus === 'disputed' || e.factStatus === 'superseded' || e.factDeleted;
}

type ImagingFactRow = typeof schema.facts.$inferSelect & { documentTitle: string | null; documentJoinedId: string | null; documentDeletedAt: string | null };

/** People of kind institution or clinic, loaded once per read, with a per-name memo (the same name recurs across facts). */
function institutionResolver(): (name: string) => string | null {
  let list: Array<{ id: string; name: string; aliases: string[] }> | null = null;
  const memo = new Map<string, string | null>();
  return (name) => {
    const key = normalizeKey(name);
    if (!key) return null;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    list ??= db()
      .select({ id: schema.people.id, name: schema.people.name, aliasesJson: schema.people.aliasesJson })
      .from(schema.people)
      .where(and(isNull(schema.people.deletedAt), inArray(schema.people.kind, ['institution', 'clinic'])))
      .all()
      .map((r) => ({ id: r.id, name: r.name, aliases: parseJson<string[]>(r.aliasesJson, []) }));
    const id = resolveInstitutionId(name, list);
    memo.set(key, id);
    return id;
  };
}

/** An imaging_result fact read as a ledger entry: the virtual `fact:<id>` entry until it is imported. */
function factEntry(x: ImagingFactRow, cite: CiteLite | undefined, resolveInstitution: (name: string) => string | null): ImagingEntry {
  const a = parseJson<ImagingAttrs>(x.attributesJson, {});
  const modality = canonicalModality(a.modality);
  const bodyPart = str(a.body_part);
  const documentId = x.sourceDocumentId ?? cite?.documentId ?? null;
  const samePage = cite && cite.documentId === documentId;
  const institution = str(a.institution);
  const written = str(a.modality);
  const title = [written && modality === 'other' ? written : modality, bodyPart].filter(Boolean).join(' ') || x.statement.slice(0, 80);
  return {
    id: `fact:${x.id}`,
    source: 'fact',
    studyId: null,
    factId: x.id,
    modality,
    bodyPart,
    title,
    performedAt: x.date,
    performedAtPrecision: x.datePrecision,
    performedAtText: x.dateText,
    institutionId: institution ? resolveInstitution(institution) : null,
    institutionName: institution,
    impression: str(a.impression),
    findings: str(a.finding),
    contrast: str(a.contrast),
    documentId,
    documentTitle: x.documentTitle ?? null,
    pageNumber: samePage ? cite!.pageNumber : null,
    citationId: samePage ? cite!.id : null,
    citationVerified: samePage ? cite!.verified : null,
    quote: samePage ? cite!.quote : null,
    factStatus: x.status,
    factBasis: basisOf(x.status, x.verdictBasis),
    factStatement: x.statement,
    factDeleted: false,
    trust: null,
    hasImages: false,
    dicomDocumentIds: [],
    dicomCount: 0,
    notes: str(a.comparison) ? `Compared with: ${str(a.comparison)}` : null,
    createdAt: x.createdAt,
    updatedAt: x.updatedAt,
  };
}

/** Follow a superseded fact to the live fact that replaced it; null when the chain ends nowhere live. */
function keeperOf(id: string, byId: Map<string, ImagingFactRow>): ImagingFactRow | null {
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && cur.status === 'superseded' && cur.supersededById && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.supersededById);
  }
  return cur && cur.id !== id && cur.status !== 'superseded' ? cur : null;
}

type StudyKey = Pick<ImagingEntry, 'modality' | 'bodyPart' | 'performedAt' | 'impression'>;

/** One study: same modality, body part, date and impression (a merged duplicate rather than a corrected reading). */
function sameStudy(a: StudyKey, b: StudyKey): boolean {
  return (
    canonicalModality(a.modality) === canonicalModality(b.modality) &&
    normalizeBodyPart(a.bodyPart).key === normalizeBodyPart(b.bodyPart).key &&
    (a.performedAt ?? null) === (b.performedAt ?? null) &&
    normalizeKey(a.impression) === normalizeKey(b.impression)
  );
}

/**
 * Every live study, rows merged with unimported imaging facts, newest first.
 * As in labs, a row whose fact was merged into a live duplicate recording the
 * same study stands in for the keeper (no second entry, nothing to import
 * again); a row whose fact was superseded by a different reading keeps its
 * superseded status and the newer fact shows.
 */
export function loadImagingEntries(): ImagingEntry[] {
  const d = db();
  const s = schema.imagingStudies;
  const rows = d
    .select({
      ...getTableColumns(s),
      institutionName: schema.people.name,
      documentTitle: schema.documents.title,
      documentJoinedId: schema.documents.id,
      documentDeletedAt: schema.documents.deletedAt,
      factStatus: schema.facts.status,
      factVerdictBasis: schema.facts.verdictBasis,
      factStatement: schema.facts.statement,
      factDeletedAt: schema.facts.deletedAt,
      factJoinedId: schema.facts.id,
    })
    .from(s)
    .leftJoin(schema.people, eq(schema.people.id, s.institutionId))
    .leftJoin(schema.documents, eq(schema.documents.id, s.documentId))
    .leftJoin(schema.facts, eq(schema.facts.id, s.factId))
    .where(isNull(s.deletedAt))
    .all()
    .filter((r) => !(r.documentJoinedId && r.documentDeletedAt));

  const f = schema.facts;
  const facts: ImagingFactRow[] = d
    .select({ ...getTableColumns(f), documentTitle: schema.documents.title, documentJoinedId: schema.documents.id, documentDeletedAt: schema.documents.deletedAt })
    .from(f)
    .leftJoin(schema.documents, eq(schema.documents.id, f.sourceDocumentId))
    .where(and(eq(f.type, 'imaging_result'), isNull(f.deletedAt)))
    .all()
    .filter((x) => !(x.documentJoinedId && x.documentDeletedAt));
  const factById = new Map(facts.map((x) => [x.id, x]));
  const resolveInstitution = institutionResolver();

  const live = (r: (typeof rows)[number]) => Boolean(r.factId && r.factJoinedId && !r.factDeletedAt);
  const linked = new Set<string>();
  for (const r of rows) if (live(r)) linked.add(r.factId!);

  const standIn = new Map<string, ImagingFactRow>();
  for (const r of rows) {
    if (!live(r) || r.factStatus !== 'superseded') continue;
    const keeper = keeperOf(r.factId!, factById);
    if (!keeper || linked.has(keeper.id)) continue;
    if (!sameStudy(r, factEntry(keeper, undefined, resolveInstitution))) continue;
    standIn.set(r.id, keeper);
    linked.add(keeper.id);
  }

  const unimported = facts.filter((x) => x.status !== 'superseded' && !linked.has(x.id));
  const cites = firstCitations([...linked, ...unimported.map((x) => x.id)]);

  const out: ImagingEntry[] = rows.map((r) => {
    const keeper = standIn.get(r.id);
    const factLive = live(r);
    const factId = keeper ? keeper.id : factLive ? r.factId : null;
    const cite = factId ? cites.get(factId) : undefined;
    const documentId = r.documentId ?? cite?.documentId ?? null;
    const samePage = cite && cite.documentId === documentId;
    const dicom = parseJson<string[]>(r.dicomDocumentIdsJson, []).filter((x) => typeof x === 'string');
    return {
      id: r.id,
      source: 'row',
      studyId: r.id,
      factId,
      modality: r.modality,
      bodyPart: r.bodyPart,
      title: r.title,
      performedAt: r.performedAt,
      performedAtPrecision: r.performedAtPrecision,
      performedAtText: r.performedAtText,
      institutionId: r.institutionId,
      institutionName: r.institutionName ?? null,
      impression: r.impression,
      findings: r.findings,
      contrast: r.contrast,
      documentId,
      documentTitle: r.documentTitle ?? null,
      pageNumber: samePage ? cite!.pageNumber : null,
      citationId: samePage ? cite!.id : null,
      citationVerified: samePage ? cite!.verified : null,
      quote: samePage ? cite!.quote : null,
      factStatus: keeper ? keeper.status : factLive ? r.factStatus : null,
      factBasis: keeper ? basisOf(keeper.status, keeper.verdictBasis) : factLive ? basisOf(r.factStatus, r.factVerdictBasis) : null,
      factStatement: keeper ? keeper.statement : factLive ? r.factStatement : null,
      factDeleted: Boolean(r.factId) && !factLive,
      trust: null,
      hasImages: Boolean(r.hasImages) || dicom.length > 0,
      dicomDocumentIds: dicom,
      dicomCount: dicom.length,
      notes: r.notes,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });

  for (const x of unimported) out.push(factEntry(x, cites.get(x.id), resolveInstitution));
  // Each study carries the trust of the fact behind it (a study entered by hand has none).
  const trust = trustFor(out.map((e) => e.factId ?? '').filter(Boolean));
  for (const e of out) e.trust = e.factId ? (trust.get(e.factId) ?? null) : null;
  out.sort(byDateDesc);
  return out;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ImagingFilter {
  modality?: string | null;
  bodyPart?: string | null;
  from?: string | null;
  to?: string | null;
  q?: string | null;
  /** Default true: studies set aside by the user's verdict (see isSetAside) are listed, tagged; false leaves them out. */
  includeDisputed?: boolean;
}

const PARTIAL_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
/** A window bound as an ISO prefix; text that is not a date is a 400, never a silently dropped filter. */
function cleanPartial(s: string | null | undefined, label = 'date'): string | null {
  const t = (s ?? '').trim();
  if (!t) return null;
  if (PARTIAL_RE.test(t)) return t;
  const iso = parsePartialDate(t).iso;
  if (!iso) throw badRequest(`${label} is not a date: "${t.slice(0, 60)}" (use YYYY, YYYY-MM or YYYY-MM-DD)`);
  return iso;
}

function inWindow(date: string | null, from: string | null, to: string | null): boolean {
  if (!from && !to) return true;
  if (!date) return false;
  const k = dateSortKey(date);
  if (from && k.slice(0, from.length) < from) return false;
  if (to && k.slice(0, to.length) > to) return false;
  return true;
}

/** Filter entries already loaded (a route that needs the list twice, with and without the modality, loads once). */
export function filterImaging(entries: ImagingEntry[], f: ImagingFilter = {}): ImagingEntry[] {
  const from = cleanPartial(f.from, 'from');
  const to = cleanPartial(f.to, 'to');
  const modality = f.modality ? canonicalModality(f.modality) : null;
  const bodyPart = normalizeKey(f.bodyPart);
  const q = (f.q ?? '').trim().toLowerCase();
  return entries.filter((e) => {
    if (!(f.includeDisputed ?? true) && isSetAside(e)) return false;
    if (modality && e.modality !== modality) return false;
    if (bodyPart && !normalizeKey(e.bodyPart).includes(bodyPart)) return false;
    if (!inWindow(e.performedAt, from, to)) return false;
    if (q) {
      const hay = [e.title, e.modality, e.bodyPart, e.impression, e.findings, e.contrast, e.institutionName, e.documentTitle, e.notes].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function listImaging(f: ImagingFilter = {}): ImagingEntry[] {
  return filterImaging(loadImagingEntries(), f);
}

export interface ModalityCount {
  modality: string;
  count: number;
}

export function modalityCounts(entries: ImagingEntry[]): ModalityCount[] {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.modality, (counts.get(e.modality) ?? 0) + 1);
  return [...counts.entries()].map(([modality, count]) => ({ modality, count })).sort((a, b) => b.count - a.count || a.modality.localeCompare(b.modality));
}

// ---------------------------------------------------------------------------
// Organised views: by modality and body part (serial studies together), and by document
// ---------------------------------------------------------------------------

export interface SerialStudy extends ImagingEntry {
  bodyPartKey: string;
  bodyPartLabel: string;
  /** Position in the series under this header, 1 = earliest; 0 for a study set aside as superseded or whose fact was deleted. */
  serial: number;
  /** The previous study of the same modality and body part (chronologically), for "compare with previous". */
  previousId: string | null;
  nextId: string | null;
}

export interface ImagingGroup {
  key: string;
  modality: string;
  bodyPartKey: string;
  bodyPart: string;
  count: number;
  /** Chronological, earliest first. */
  studies: SerialStudy[];
}

function byDateAsc(a: ImagingEntry, b: ImagingEntry): number {
  return dateSortKey(a.performedAt).localeCompare(dateSortKey(b.performedAt)) || a.createdAt.localeCompare(b.createdAt);
}

function modalityRank(m: string): number {
  const i = (IMAGING_MODALITIES as readonly string[]).indexOf(m);
  return i < 0 ? IMAGING_MODALITIES.length : i;
}

/**
 * Group studies by modality and body part so serial studies (every MRI brain)
 * sit chronologically under one header, each knowing its predecessor.
 * Modalities follow the enum order (MRI, CT, PET, ...), body parts
 * alphabetically with "unspecified" last. A study whose fact was superseded
 * (a merged duplicate, a replaced reading) or deleted stays listed under its
 * header but is not numbered and is nobody's "previous".
 */
export function organiseImaging(entries: ImagingEntry[]): ImagingGroup[] {
  const groups = new Map<string, ImagingGroup>();
  for (const e of entries) {
    const bp = normalizeBodyPart(e.bodyPart);
    const key = `${e.modality}|${bp.key}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, modality: e.modality, bodyPartKey: bp.key, bodyPart: bp.label, count: 0, studies: [] };
      groups.set(key, g);
    }
    g.studies.push({ ...e, bodyPartKey: bp.key, bodyPartLabel: bp.label, serial: 0, previousId: null, nextId: null });
    g.count++;
  }
  const out = [...groups.values()];
  for (const g of out) {
    g.studies.sort(byDateAsc);
    const serial = g.studies.filter((s) => s.factStatus !== 'superseded' && !s.factDeleted);
    serial.forEach((s, i) => {
      s.serial = i + 1;
      s.previousId = i > 0 ? serial[i - 1].id : null;
      s.nextId = i < serial.length - 1 ? serial[i + 1].id : null;
    });
  }
  out.sort((a, b) => modalityRank(a.modality) - modalityRank(b.modality) || a.modality.localeCompare(b.modality) || (a.bodyPartKey === '' ? 1 : 0) - (b.bodyPartKey === '' ? 1 : 0) || a.bodyPart.localeCompare(b.bodyPart));
  return out;
}

export interface DocumentImaging {
  documentId: string | null;
  title: string;
  date: string | null;
  datePrecision: string;
  tier: string | null;
  category: string | null;
  count: number;
  /** Chronological, earliest first. */
  studies: ImagingEntry[];
}

/** Studies stacked under the report they came from; hand-entered studies without a report form one last group. */
export function imagingByDocument(entries: ImagingEntry[]): DocumentImaging[] {
  const groups = new Map<string, ImagingEntry[]>();
  for (const e of entries) {
    const k = e.documentId ?? '';
    const g = groups.get(k);
    if (g) g.push(e);
    else groups.set(k, [e]);
  }
  const ids = [...groups.keys()].filter(Boolean);
  const docs = new Map<string, { title: string; date: string | null; precision: string; tier: string; category: string }>();
  if (ids.length) {
    const rows = db()
      .select({ id: schema.documents.id, title: schema.documents.title, documentDate: schema.documents.documentDate, documentDatePrecision: schema.documents.documentDatePrecision, sourceTier: schema.documents.sourceTier, category: schema.documents.category })
      .from(schema.documents)
      .where(inArray(schema.documents.id, ids))
      .all();
    for (const r of rows) docs.set(r.id, { title: r.title, date: r.documentDate, precision: r.documentDatePrecision, tier: r.sourceTier, category: r.category });
  }
  const out: DocumentImaging[] = [];
  for (const [documentId, list] of groups) {
    const doc = documentId ? docs.get(documentId) : undefined;
    const studies = list.slice().sort(byDateAsc);
    const latest = [...studies].reverse().find((s) => s.performedAt);
    out.push({
      documentId: documentId || null,
      title: doc?.title ?? (documentId ? list[0].documentTitle ?? 'Document' : 'Entered by hand (no report)'),
      date: doc?.date ?? latest?.performedAt ?? null,
      datePrecision: doc?.date ? doc.precision : latest?.performedAtPrecision ?? 'unknown',
      tier: doc ? doc.tier : null,
      category: doc?.category ?? null,
      count: studies.length,
      studies,
    });
  }
  out.sort((a, b) => {
    if (!a.documentId !== !b.documentId) return a.documentId ? -1 : 1;
    if (!a.date !== !b.date) return a.date ? -1 : 1;
    return dateSortKey(b.date).localeCompare(dateSortKey(a.date)) || a.title.localeCompare(b.title);
  });
  return out;
}

function documentsLite(ids: string[]): DocumentLite[] {
  if (!ids.length) return [];
  const rows = db()
    .select({ id: schema.documents.id, title: schema.documents.title, kind: schema.documents.kind, documentDate: schema.documents.documentDate })
    .from(schema.documents)
    .where(and(inArray(schema.documents.id, ids), isNull(schema.documents.deletedAt)))
    .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((x): x is DocumentLite => Boolean(x));
}

export function getImaging(id: string): ImagingDetail {
  const all = loadImagingEntries();
  const e = all.find((x) => x.id === id);
  if (!e) throw notFound('imaging study not found');
  const others = all.filter((x) => x.id !== id);
  others.sort((a, b) => (a.modality === e.modality ? 0 : 1) - (b.modality === e.modality ? 0 : 1) || byDateDesc(a, b));
  return {
    ...e,
    dicomDocuments: documentsLite(e.dicomDocumentIds),
    compareCandidates: others.map((o) => ({ id: o.id, title: o.title, modality: o.modality, performedAt: o.performedAt, performedAtPrecision: o.performedAtPrecision })),
  };
}

export interface ImagingComparison {
  a: ImagingEntry;
  b: ImagingEntry;
  /** Which side the diff starts from (the older study, or `b` when dates tie or are unknown). */
  older: 'a' | 'b';
  impression: DiffSegment[];
  findings: DiffSegment[];
  stats: { impression: ReturnType<typeof diffStats>; findings: ReturnType<typeof diffStats> };
}

/** Word-level diff of impressions and findings, from the older study to the newer one. */
export function compareImaging(id: string, withId: string): ImagingComparison {
  if (id === withId) throw badRequest('pick a different study to compare with');
  const all = loadImagingEntries();
  const a = all.find((x) => x.id === id);
  const b = all.find((x) => x.id === withId);
  if (!a) throw notFound('imaging study not found');
  if (!b) throw notFound('the study to compare with was not found');
  const older: 'a' | 'b' = dateSortKey(a.performedAt) < dateSortKey(b.performedAt) ? 'a' : 'b';
  const from = older === 'a' ? a : b;
  const to = older === 'a' ? b : a;
  const impression = wordDiff(from.impression, to.impression);
  const findings = wordDiff(from.findings, to.findings);
  return { a, b, older, impression, findings, stats: { impression: diffStats(impression), findings: diffStats(findings) } };
}

// ---------------------------------------------------------------------------
// Validation and writes
// ---------------------------------------------------------------------------

const optText = (max = 4000) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v && v.trim() ? v.trim() : null));

const imagingFields = {
  title: optText(300),
  modality: z.string().trim().max(60).optional(),
  bodyPart: optText(200),
  performedAt: optText(32),
  performedAtText: optText(200),
  institutionId: optText(64),
  institutionName: optText(300),
  impression: optText(20000),
  findings: optText(20000),
  contrast: optText(200),
  documentId: optText(64),
  factId: optText(64),
  hasImages: z.boolean().optional(),
  dicomDocumentIds: z.array(z.string().min(1)).max(500).optional(),
  notes: optText(4000),
};
export const imagingInput = z.object(imagingFields);
export const imagingPatch = z.object(imagingFields).partial();
export type ImagingInput = z.input<typeof imagingInput>;

function resolveDate(iso: string | null | undefined, text: string | null | undefined, current?: ImagingRow): Pick<ImagingInsert, 'performedAt' | 'performedAtPrecision' | 'performedAtText'> {
  if (iso) {
    const p = parsePartialDate(iso);
    return { performedAt: p.iso, performedAtPrecision: p.precision, performedAtText: text ?? current?.performedAtText ?? iso };
  }
  if (text !== undefined) {
    const p = parsePartialDate(text);
    return { performedAt: p.iso, performedAtPrecision: p.precision, performedAtText: p.text };
  }
  if (iso === null) return { performedAt: null, performedAtPrecision: 'unknown', performedAtText: current?.performedAtText ?? null };
  return { performedAt: current?.performedAt ?? null, performedAtPrecision: current?.performedAtPrecision ?? 'unknown', performedAtText: current?.performedAtText ?? null };
}

function assertDocuments(ids: Array<string | null | undefined>): void {
  const want = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!want.length) return;
  const found = new Set(
    db()
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(and(inArray(schema.documents.id, want), isNull(schema.documents.deletedAt)))
      .all()
      .map((r) => r.id),
  );
  const missing = want.filter((id) => !found.has(id));
  if (missing.length) throw badRequest(`document not found: ${missing.join(', ')}`);
}

function assertFactFree(factId: string | null | undefined, exceptId?: string): void {
  if (!factId) return;
  const f = db().select({ id: schema.facts.id, type: schema.facts.type }).from(schema.facts).where(and(eq(schema.facts.id, factId), isNull(schema.facts.deletedAt))).get();
  if (!f) throw badRequest('factId does not refer to an existing fact');
  if (f.type !== 'imaging_result') throw badRequest('factId must point at an imaging_result fact');
  const taken = db().select({ id: schema.imagingStudies.id }).from(schema.imagingStudies).where(and(eq(schema.imagingStudies.factId, factId), isNull(schema.imagingStudies.deletedAt))).get();
  if (taken && taken.id !== exceptId) throw conflict('that fact is already linked to an imaging study');
}

function rowById(id: string): ImagingRow | null {
  return db().select().from(schema.imagingStudies).where(and(eq(schema.imagingStudies.id, id), isNull(schema.imagingStudies.deletedAt))).get() ?? null;
}

type ImagingIndexFields = Pick<ImagingRow, 'id' | 'title' | 'modality' | 'bodyPart' | 'performedAt' | 'impression' | 'findings' | 'notes'>;

/** The search entry: what the study is, plus its impression, findings and the user's notes, so any of their words find it. */
function indexImaging(row: ImagingIndexFields, institutionName: string | null): void {
  indexEntity('imaging', row.id, row.title, [row.modality, row.bodyPart, institutionName, row.performedAt, row.impression, row.findings, row.notes].filter(Boolean).join(' · '));
}

/**
 * Rewrite the search entry of every live study (one transaction). Entries
 * written before notes and findings were indexed only gain them on the next
 * save; this brings them all up to date at once. Returns the count.
 */
export function reindexImagingSearch(): number {
  const d = db();
  const s = schema.imagingStudies;
  const rows = d
    .select({ id: s.id, title: s.title, modality: s.modality, bodyPart: s.bodyPart, performedAt: s.performedAt, impression: s.impression, findings: s.findings, notes: s.notes, institutionName: schema.people.name })
    .from(s)
    .leftJoin(schema.people, eq(schema.people.id, s.institutionId))
    .where(isNull(s.deletedAt))
    .all();
  d.transaction(() => {
    for (const r of rows) indexImaging(r, r.institutionName);
  });
  return rows.length;
}

export function createImaging(raw: unknown): ImagingDetail {
  const input = parseOrThrow(imagingInput, raw);
  const modality = canonicalModality(input.modality);
  const written = input.modality?.trim() || null;
  const title = input.title ?? ([modality === 'other' && written ? written : modality, input.bodyPart].filter(Boolean).join(' ') || 'Imaging study');
  assertDocuments([input.documentId, ...(input.dicomDocumentIds ?? [])]);
  assertFactFree(input.factId);
  const institutionId = input.institutionId ?? (input.institutionName ? resolveInstitutionId(input.institutionName) : null);
  const now = nowIso();
  const dicom = [...new Set(input.dicomDocumentIds ?? [])];
  const row: ImagingInsert = {
    id: newId(),
    modality,
    bodyPart: input.bodyPart ?? null,
    title,
    ...resolveDate(input.performedAt, input.performedAtText),
    institutionId,
    impression: input.impression ?? null,
    findings: input.findings ?? null,
    contrast: input.contrast ?? null,
    documentId: input.documentId ?? null,
    factId: input.factId ?? null,
    hasImages: input.hasImages ?? dicom.length > 0,
    dicomDocumentIdsJson: JSON.stringify(dicom),
    notes: input.notes ?? (modality === 'other' && written ? `Modality as written: ${written}` : null),
    createdAt: now,
    updatedAt: now,
  };
  db().insert(schema.imagingStudies).values(row).run();
  const saved = getImaging(row.id);
  indexImaging(rowById(row.id)!, saved.institutionName);
  return saved;
}

export function updateImaging(id: string, raw: unknown): ImagingDetail {
  if (id.startsWith('fact:')) throw conflict('this study comes straight from an extracted fact; import it (from facts) before editing');
  const current = rowById(id);
  if (!current) throw notFound('imaging study not found');
  const patch = parseOrThrow(imagingPatch, raw);
  const set: Partial<ImagingInsert> = { updatedAt: nowIso() };
  if (patch.title !== undefined && patch.title) set.title = patch.title;
  if (patch.modality !== undefined) set.modality = canonicalModality(patch.modality);
  if (patch.bodyPart !== undefined) set.bodyPart = patch.bodyPart;
  if (patch.performedAt !== undefined || patch.performedAtText !== undefined) Object.assign(set, resolveDate(patch.performedAt, patch.performedAtText, current));
  if (patch.institutionId !== undefined) set.institutionId = patch.institutionId;
  else if (patch.institutionName !== undefined) set.institutionId = patch.institutionName ? resolveInstitutionId(patch.institutionName) : null;
  if (patch.impression !== undefined) set.impression = patch.impression;
  if (patch.findings !== undefined) set.findings = patch.findings;
  if (patch.contrast !== undefined) set.contrast = patch.contrast;
  if (patch.documentId !== undefined) {
    assertDocuments([patch.documentId]);
    set.documentId = patch.documentId;
  }
  if (patch.factId !== undefined) {
    assertFactFree(patch.factId, id);
    set.factId = patch.factId;
  }
  if (patch.dicomDocumentIds !== undefined) {
    assertDocuments(patch.dicomDocumentIds);
    const dicom = [...new Set(patch.dicomDocumentIds)];
    set.dicomDocumentIdsJson = JSON.stringify(dicom);
    if (patch.hasImages === undefined && dicom.length) set.hasImages = true;
  }
  if (patch.hasImages !== undefined) set.hasImages = patch.hasImages;
  if (patch.notes !== undefined) set.notes = patch.notes;
  db().update(schema.imagingStudies).set(set).where(eq(schema.imagingStudies.id, id)).run();
  const saved = getImaging(id);
  indexImaging(rowById(id)!, saved.institutionName);
  return saved;
}

export function deleteImaging(id: string): void {
  if (id.startsWith('fact:')) throw conflict('extracted studies are deleted from the Facts ledger, not here');
  const current = rowById(id);
  if (!current) throw notFound('imaging study not found');
  const now = nowIso();
  db().update(schema.imagingStudies).set({ deletedAt: now, updatedAt: now }).where(eq(schema.imagingStudies.id, id)).run();
  removeEntityIndex('imaging', id);
}

export const fromFactsInput = z.object({ factIds: z.array(z.string().min(1)).max(5000).optional() });

/** Unimported imaging_result facts become studies (idempotent through `factId`); disputed facts are skipped. */
export function importFromFacts(raw: unknown = {}): { created: number; skipped: number; items: ImagingEntry[] } {
  const input = parseOrThrow(fromFactsInput, raw ?? {});
  const wanted = input.factIds ? new Set(input.factIds) : null;
  const candidates = loadImagingEntries().filter((e) => e.source === 'fact' && e.factId && (!wanted || wanted.has(e.factId)));
  const now = nowIso();
  const created: string[] = [];
  let skipped = wanted ? wanted.size - candidates.length : 0;
  const rows: Array<{ row: ImagingInsert & ImagingIndexFields; institutionName: string | null }> = [];
  for (const e of candidates) {
    if (e.factStatus === 'disputed') {
      skipped++;
      continue;
    }
    const row: ImagingInsert & ImagingIndexFields = {
      id: newId(),
      modality: e.modality,
      bodyPart: e.bodyPart,
      title: e.title,
      performedAt: e.performedAt,
      performedAtPrecision: e.performedAtPrecision,
      performedAtText: e.performedAtText,
      institutionId: e.institutionId,
      impression: e.impression,
      findings: e.findings,
      contrast: e.contrast,
      documentId: e.documentId,
      factId: e.factId,
      hasImages: false,
      dicomDocumentIdsJson: '[]',
      notes: e.notes ?? (e.institutionName && !e.institutionId ? `Institution as written: ${e.institutionName}` : null),
      createdAt: now,
      updatedAt: now,
    };
    rows.push({ row, institutionName: e.institutionName });
  }
  // One transaction: all studies (and their search entries) land together or not at all.
  const d = db();
  d.transaction(() => {
    for (const { row, institutionName } of rows) {
      d.insert(schema.imagingStudies).values(row).run();
      indexImaging(row, institutionName);
      created.push(row.id);
    }
  });
  const set = new Set(created);
  return { created: created.length, skipped, items: created.length ? loadImagingEntries().filter((e) => set.has(e.id)) : [] };
}
