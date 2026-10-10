/**
 * The builder form state and its mapping to the API config. Kept apart from
 * the components so a stored packet can be turned back into a draft
 * ("use as template") and the draft can be remembered between visits.
 *
 * The free-text fields (title, recipient, purpose, cover summary) are case
 * narrative, so they are remembered in memory for this tab only and dropped
 * when Casefile locks; localStorage (plaintext on disk) keeps only the
 * choices: picked document ids, scopes, sections and analytes.
 *
 * Lab tests listed apart since 2026-10 (rule 9: similar names are not one test;
 * hs-CRP is no longer CRP, absolute counts no longer the percentages...): a
 * draft saved before then, or a packet used as a template, chose the old test,
 * which held those values too. Its old keys are kept as chosen, and the packet
 * still includes every value they used to include (LAB_KEY_SPLITS, amendment
 * I3: no value is dropped from a packet).
 */
import type { TimelineKind } from '@shared/timeline';
import { LOCK_EVENT } from '../../api/client';
import type { PacketConfig } from '../../api/export';

/** 'chosen' = the explicit id list a template carried (only offered when there is one). */
export type Scope = 'confirmed' | 'all' | 'none' | 'chosen';

export interface BuilderState {
  title: string;
  recipient: string;
  purpose: string;
  documentIds: string[];
  factScope: Scope;
  /** The ids behind factScope 'chosen'. */
  factIdList: string[];
  factsFromPacketDocumentsOnly: boolean;
  findingScope: Scope;
  /** The ids behind findingScope 'chosen'. */
  findingIdList: string[];
  includeTimeline: boolean;
  timelineFrom: string;
  timelineTo: string;
  /** Empty = every kind. */
  timelineKinds: TimelineKind[];
  includeEmergencyCard: boolean;
  includeRecordsIndex: boolean;
  includeMedications: boolean;
  /** The Care team summary page (2026-10-09, request 6). */
  includeCareTeam?: boolean;
  includeLabs: string[];
  /**
   * Lab test keys chosen before 2026-10 (a draft saved then, or a template): each still includes the tests that were
   * one test with it then (LAB_KEY_SPLITS). Absent for choices made since.
   */
  legacyLabKeys?: string[];
  coverSummary: string;
}

export const DRAFT_KEY = 'casefile.export.draft';
/** The version of the lab test keys a draft was saved with (2: tests listed apart since 2026-10). */
export const LAB_KEYS_VERSION = 2;

/**
 * Tests that were one test before 2026-10 and are listed apart since (design 2026-10 section 1.11, amendment H1): the
 * old key, and the keys that left it.
 */
export const LAB_KEY_SPLITS: Readonly<Record<string, readonly string[]>> = {
  crp: ['hs crp'],
  ana: ['ana titer', 'ana pattern'],
  'vitamin d': ['vitamin d3'],
  'csf serum glucose ratio': ['csf serum glucose', 'csf blood glucose'],
  'albumin index': ['csf serum albumin', 'albumin ratio', 'albumin quotient'],
  'igg synthesis rate': ['igg synthesis', 'intrathecal igg synthesis'],
  rdw: ['rdw cv', 'rdw sd'],
  neutrophils: ['neutrophils absolute', 'neutrophil count'],
  lymphocytes: ['lymphocytes absolute', 'lymphocyte count'],
  monocytes: ['monocytes absolute', 'monocyte count'],
  eosinophils: ['eosinophils absolute', 'eosinophil count'],
  basophils: ['basophils absolute', 'basophil count'],
  bun: ['urea'],
  egfr: ['egfr african american', 'egfr non african american', 'egfr ckd epi 2021', 'egfr ckd epi'],
  folate: ['rbc folate'],
  ldl: ['ldl direct'],
  'total protein': ['protein'],
  'csf cell count': ['csf cell count corrected'],
};

/** The keys a packet includes for keys chosen before 2026-10: each, and the tests that left it, once each. */
export function expandLegacyLabKeys(keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const k of keys) for (const x of [k, ...(LAB_KEY_SPLITS[k] ?? [])]) if (!out.includes(x)) out.push(x);
  return out;
}

/** What the packet includes: the chosen keys, and for one chosen before 2026-10 the tests that left it too. */
export function includedLabKeys(s: Pick<BuilderState, 'includeLabs' | 'legacyLabKeys'>): string[] {
  const legacy = new Set(s.legacyLabKeys ?? []);
  const out: string[] = [];
  for (const k of s.includeLabs) for (const x of legacy.has(k) ? expandLegacyLabKeys([k]) : [k]) if (!out.includes(x)) out.push(x);
  return out;
}

/** Never written to localStorage. */
const TEXT_FIELDS = ['title', 'recipient', 'purpose', 'coverSummary'] as const;

export function emptyState(): BuilderState {
  return {
    title: '',
    recipient: '',
    purpose: '',
    documentIds: [],
    factScope: 'confirmed',
    factIdList: [],
    factsFromPacketDocumentsOnly: false,
    findingScope: 'confirmed',
    findingIdList: [],
    includeTimeline: false,
    timelineFrom: '',
    timelineTo: '',
    timelineKinds: [],
    includeEmergencyCard: true,
    includeRecordsIndex: true,
    includeMedications: true,
    includeLabs: [],
    coverSummary: '',
  };
}

function scopeToConfig(scope: Scope, ids: string[]): Exclude<PacketConfig['factIds'], undefined> {
  if (scope === 'chosen') return ids.length ? ids : 'none';
  return scope;
}

export function toConfig(s: BuilderState): PacketConfig {
  return {
    title: s.title.trim(),
    recipient: s.recipient.trim() || null,
    purpose: s.purpose.trim() || null,
    documentIds: s.documentIds,
    factIds: scopeToConfig(s.factScope, s.factIdList),
    factsFromPacketDocumentsOnly: s.factsFromPacketDocumentsOnly,
    findingIds: scopeToConfig(s.findingScope, s.findingIdList),
    timeline: s.includeTimeline ? { from: s.timelineFrom.trim() || null, to: s.timelineTo.trim() || null, kinds: s.timelineKinds.length ? s.timelineKinds : null } : null,
    includeEmergencyCard: s.includeEmergencyCard,
    includeRecordsIndex: s.includeRecordsIndex,
    includeMedications: s.includeMedications,
    includeCareTeam: Boolean(s.includeCareTeam),
    includeLabs: includedLabKeys(s),
    coverSummary: s.coverSummary.trim() || null,
  };
}

/** An explicit id list stays an id list (scope 'chosen'); it is never widened to 'all'. */
function scopeOf(v: PacketConfig['factIds'] | PacketConfig['findingIds']): { scope: Scope; ids: string[] } {
  if (v === 'all' || v === 'confirmed' || v === 'none') return { scope: v, ids: [] };
  if (Array.isArray(v)) return v.length ? { scope: 'chosen', ids: v } : { scope: 'none', ids: [] };
  return { scope: 'none', ids: [] };
}

export function fromConfig(c: PacketConfig): BuilderState {
  const facts = scopeOf(c.factIds);
  const findings = scopeOf(c.findingIds);
  return {
    title: c.title ?? '',
    recipient: c.recipient ?? '',
    purpose: c.purpose ?? '',
    documentIds: Array.isArray(c.documentIds) ? c.documentIds : [],
    factScope: facts.scope,
    factIdList: facts.ids,
    factsFromPacketDocumentsOnly: Boolean(c.factsFromPacketDocumentsOnly),
    findingScope: findings.scope,
    findingIdList: findings.ids,
    includeTimeline: Boolean(c.timeline),
    timelineFrom: c.timeline?.from ?? '',
    timelineTo: c.timeline?.to ?? '',
    timelineKinds: c.timeline?.kinds ?? [],
    includeEmergencyCard: c.includeEmergencyCard ?? true,
    includeRecordsIndex: c.includeRecordsIndex ?? true,
    includeMedications: c.includeMedications ?? true,
    includeCareTeam: Boolean(c.includeCareTeam),
    includeLabs: Array.isArray(c.includeLabs) ? c.includeLabs : [],
    // A packet's saved choices carry no version: read as chosen before 2026-10, so a template never drops a value.
    legacyLabKeys: Array.isArray(c.includeLabs) && c.includeLabs.length ? [...c.includeLabs] : undefined,
    coverSummary: c.coverSummary ?? '',
  };
}

/** The whole draft, for this tab only. */
let memDraft: BuilderState | null = null;
/** Set by a lock: a page still mounted while the lock screen comes up must not write its text back. */
let lockedSinceRead = false;

function withoutText(s: Partial<BuilderState>): Partial<BuilderState> {
  const out: Partial<BuilderState> = { ...s };
  for (const k of TEXT_FIELDS) delete out[k];
  return out;
}

export function readDraft(): BuilderState | null {
  lockedSinceRead = false;
  if (memDraft) return { ...memDraft };
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BuilderState> & { labKeysVersion?: number };
    // Older versions stored the free text too; rewrite without it.
    if (TEXT_FIELDS.some((k) => k in parsed)) localStorage.setItem(DRAFT_KEY, JSON.stringify(withoutText(parsed)));
    const { labKeysVersion, ...rest } = withoutText(parsed) as Partial<BuilderState> & { labKeysVersion?: number };
    const draft: BuilderState = { ...emptyState(), ...rest };
    // A draft saved before 2026-10: its lab tests keep every value they included then.
    if ((labKeysVersion ?? 1) < LAB_KEYS_VERSION && draft.includeLabs.length && !draft.legacyLabKeys) draft.legacyLabKeys = [...draft.includeLabs];
    return draft;
  } catch {
    return null;
  }
}

export function writeDraft(s: BuilderState): void {
  if (lockedSinceRead) return;
  memDraft = { ...s };
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...withoutText(s), labKeysVersion: LAB_KEYS_VERSION }));
  } catch {
    // ignore
  }
}

export function clearDraft(): void {
  memDraft = null;
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
}

// A lock (manual, idle or a 401/423) ends the session: drop the in-memory text
// so the next person to unlock this browser does not find it pre-filled.
if (typeof window !== 'undefined') {
  window.addEventListener(LOCK_EVENT, () => {
    memDraft = null;
    lockedSinceRead = true;
  });
}
