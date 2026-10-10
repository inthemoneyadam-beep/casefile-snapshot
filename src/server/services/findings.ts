/**
 * Findings: what the cross-reference engine produced, with evidence that
 * resolves to rows, a stable fingerprint so re-runs update instead of
 * duplicating, and the user's verdict, which re-runs never touch.
 *
 * Evidence rows point at facts, citations, communications, lab results and
 * documents through their own columns. Other rows (inventory records,
 * medications, medication events, symptoms, encounters, tasks) have no column
 * in `finding_evidence`, so they ride in `note` as `@kind:id <text>` and are
 * expanded on read. Every reference is checked against its table before a
 * finding is written; a draft with nothing that resolves is dropped and
 * counted.
 */
import { and, desc, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db';
import { newId, normalizeKey, nowIso, parseJson, sha256 } from '../util/ids';
import { badRequest, notFound } from '../util/errors';
import { indexEntity, removeEntityIndex } from './search';
import { pageTextLookupFor } from './facts';
import { locateCitation, textSimilarity } from '../ai/citations';
import { modelFor } from '../ai/client';
import { buildRuleContext, runAllRules, CROSSREF_RULE_IDS, type CrossrefScope, type DraftEvidence, type EvidenceRef, type FindingDraft } from './crossref-rules';
import { FINDING_CATEGORIES, FINDING_SEVERITIES, FINDING_STATUSES } from '../../shared/enums';
import { todayIso } from '../../shared/dates';

export type FindingRow = typeof schema.findings.$inferSelect;
export type EvidenceRow = typeof schema.findingEvidence.$inferSelect;
export type RunRow = typeof schema.crossrefRuns.$inferSelect;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** Verdict-note prefix that marks a rule finding the engine resolved itself (never a user's verdict). */
export const AUTO_CLEARED_PREFIX = 'Cleared automatically:';

/** A note the user wrote: anything other than empty or the engine's own clearance line. */
export function isUserNote(note: string | null | undefined): boolean {
  const text = (note ?? '').trim();
  return Boolean(text) && !text.startsWith(AUTO_CLEARED_PREFIX);
}

/**
 * The note to keep when an automatically cleared finding reopens: the
 * engine's clearance line (always the first line) goes, anything the user
 * added below it stays.
 */
export function noteAfterReopen(note: string | null | undefined): string | null {
  const text = note ?? '';
  if (!text.startsWith(AUTO_CLEARED_PREFIX)) return text.trim() || null;
  const nl = text.indexOf('\n');
  return nl === -1 ? null : text.slice(nl + 1).trim() || null;
}

// ---------------------------------------------------------------------------
// Fingerprints and evidence notes
// ---------------------------------------------------------------------------

/** rule:<ruleId>:<hash of key parts> or ai:<category>:<hash>. Stable across runs for the same key. */
export function fingerprintOf(draft: Pick<FindingDraft, 'ruleId' | 'category' | 'key'>): string {
  const ns = draft.ruleId ? `rule:${draft.ruleId}` : `ai:${draft.category}`;
  return `${ns}:${sha256(draft.key.join('\u001f')).slice(0, 32)}`;
}

const REF_KINDS = new Set<EvidenceRef['kind']>(['record', 'medication', 'medication_event', 'symptom', 'encounter', 'task']);
const NOTE_REF = /^@([a-z_]+):([^\s]+)\s*([\s\S]*)$/;

export function encodeNote(ref: EvidenceRef | null | undefined, note: string | null | undefined): string | null {
  const text = (note ?? '').trim();
  if (ref) return `@${ref.kind}:${ref.id}${text ? ` ${text}` : ''}`;
  return text || null;
}

export function decodeNote(raw: string | null | undefined): { ref: EvidenceRef | null; note: string | null } {
  if (!raw) return { ref: null, note: null };
  const m = raw.match(NOTE_REF);
  if (m && REF_KINDS.has(m[1] as EvidenceRef['kind'])) return { ref: { kind: m[1] as EvidenceRef['kind'], id: m[2] }, note: m[3].trim() || null };
  return { ref: null, note: raw };
}

// ---------------------------------------------------------------------------
// Evidence validation
// ---------------------------------------------------------------------------

export interface ValidatedEvidence {
  factId: string | null;
  citationId: string | null;
  documentId: string | null;
  communicationId: string | null;
  labResultId: string | null;
  ref: EvidenceRef | null;
  note: string | null;
  pendingCitation: { documentId: string; pageNumber: number; quote: string } | null;
  /** True when at least one id (or the pending citation's document) resolves. */
  resolves: boolean;
}

function existsIn(table: 'facts' | 'citations' | 'documents' | 'communications' | 'lab_results' | 'records_inventory' | 'medications' | 'medication_events' | 'symptom_definitions' | 'encounters' | 'tasks', id: string, softDelete: boolean): boolean {
  const d = db();
  const row = softDelete
    ? d.get<{ n: number }>(sql`select count(*) as n from ${sql.raw(table)} where id = ${id} and deleted_at is null`)
    : d.get<{ n: number }>(sql`select count(*) as n from ${sql.raw(table)} where id = ${id}`);
  return (row?.n ?? 0) > 0;
}

function refExists(ref: EvidenceRef): boolean {
  switch (ref.kind) {
    case 'record':
      return existsIn('records_inventory', ref.id, true);
    case 'medication':
      return existsIn('medications', ref.id, true);
    case 'medication_event':
      return existsIn('medication_events', ref.id, true);
    case 'symptom':
      return existsIn('symptom_definitions', ref.id, false);
    case 'encounter':
      return existsIn('encounters', ref.id, true);
    case 'task':
      return existsIn('tasks', ref.id, true);
  }
}

/**
 * Check every reference. Ids that do not resolve are dropped from the item;
 * an item keeps `resolves = false` when nothing is left but a note.
 */
export function validateEvidence(items: DraftEvidence[]): { items: ValidatedEvidence[]; droppedIds: number } {
  let droppedIds = 0;
  const out: ValidatedEvidence[] = [];
  const check = (ok: boolean) => {
    if (!ok) droppedIds++;
    return ok;
  };
  for (const e of items) {
    const factId = e.factId && check(existsIn('facts', e.factId, true)) ? e.factId : null;
    const citationId = e.citationId && check(existsIn('citations', e.citationId, false)) ? e.citationId : null;
    const documentId = e.documentId && check(existsIn('documents', e.documentId, true)) ? e.documentId : null;
    const communicationId = e.communicationId && check(existsIn('communications', e.communicationId, true)) ? e.communicationId : null;
    const labResultId = e.labResultId && check(existsIn('lab_results', e.labResultId, true)) ? e.labResultId : null;
    const ref = e.ref && check(refExists(e.ref)) ? e.ref : null;
    let pending = e.pendingCitation ?? null;
    if (pending && !check(existsIn('documents', pending.documentId, true))) pending = null;
    const resolves = Boolean(factId || citationId || documentId || communicationId || labResultId || ref || pending);
    const note = (e.note ?? '').trim() || null;
    if (!resolves && !note) continue;
    out.push({ factId, citationId, documentId, communicationId, labResultId, ref, note, pendingCitation: pending, resolves });
  }
  return { items: out, droppedIds };
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

export interface ApplyResult {
  created: number;
  updated: number;
  unchanged: number;
  /** Drafts dropped because no evidence resolved. */
  invalid: number;
  droppedIds: number;
  fingerprints: string[];
  findingIds: string[];
}

function evidenceSignature(items: Array<{ factId: string | null; citationId: string | null; documentId: string | null; communicationId: string | null; labResultId: string | null; note: string | null }>): string {
  return items
    .map((e) => [e.factId, e.citationId, e.documentId, e.communicationId, e.labResultId, e.note].map((x) => x ?? '').join('|'))
    .sort()
    .join('\n');
}

/**
 * The search entry: the finding's own words plus the note the user wrote with
 * their verdict (the engine's "Cleared automatically" line is left out, any
 * words the user added under it are kept). A deleted finding leaves the index.
 */
function indexFinding(f: FindingRow): void {
  if (f.deletedAt) {
    removeEntityIndex('finding', f.id);
    return;
  }
  indexEntity('finding', f.id, f.title, [f.category.replace(/_/g, ' '), f.whyItMatters, f.detail, f.ruleId, noteAfterReopen(f.verdictNote)].filter(Boolean).join(' '));
}

/**
 * Rewrite the search entry of every finding (one transaction; deleted ones
 * are removed). Entries written before verdict notes were indexed only gain
 * them on the next change; this brings them all up to date at once. Returns
 * the count of live findings indexed.
 */
export function reindexFindingsSearch(): number {
  const d = db();
  const rows = d.select().from(schema.findings).all();
  d.transaction(() => {
    for (const f of rows) indexFinding(f);
  });
  return rows.filter((f) => !f.deletedAt).length;
}

/** Verify a passage against the page text and store it as a citation of the finding (reusing an identical one). */
function findingCitation(findingId: string, c: { documentId: string; pageNumber: number; quote: string }): string {
  const d = db();
  const existing = d
    .select({ id: schema.citations.id })
    .from(schema.citations)
    .where(and(eq(schema.citations.findingId, findingId), eq(schema.citations.documentId, c.documentId), eq(schema.citations.quote, c.quote)))
    .get();
  if (existing) return existing.id;
  const found = locateCitation(pageTextLookupFor(c.documentId), c.pageNumber, c.quote);
  const id = newId();
  d.insert(schema.citations)
    .values({ id, findingId, documentId: c.documentId, pageNumber: found?.page ?? c.pageNumber, quote: c.quote, charStart: found?.start ?? null, charEnd: found?.end ?? null, verified: Boolean(found), matchKind: found?.kind ?? 'none', createdAt: nowIso() })
    .run();
  return id;
}

// ---------------------------------------------------------------------------
// Matching a reworded AI finding to the one already on file
// ---------------------------------------------------------------------------

/** Title similarity (bigram Dice over normalised titles) above which an AI draft is the same finding as one on file sharing evidence. */
export const AI_MATCH_SIMILARITY = 0.8;
/** The lower bar when the draft cites exactly the same evidence ids as the finding on file. */
export const AI_MATCH_SIMILARITY_SAME_EVIDENCE = 0.6;

interface AiCandidate {
  id: string;
  category: string;
  titleKey: string;
  evidence: Set<string>;
}

function evidenceIdsOf(items: Array<{ factId: string | null; communicationId: string | null; documentId: string | null }>): Set<string> {
  const out = new Set<string>();
  for (const e of items) {
    if (e.factId) out.add(`F:${e.factId}`);
    if (e.communicationId) out.add(`C:${e.communicationId}`);
    if (e.documentId) out.add(`D:${e.documentId}`);
  }
  return out;
}

/** Every AI finding on file (any status) with the F/C/D ids of its evidence. */
function loadAiCandidates(): AiCandidate[] {
  const d = db();
  const live = and(eq(schema.findings.origin, 'ai'), isNull(schema.findings.deletedAt));
  const rows = d.select({ id: schema.findings.id, category: schema.findings.category, title: schema.findings.title }).from(schema.findings).where(live).all();
  if (!rows.length) return [];
  const evidence = d
    .select({ findingId: schema.findingEvidence.findingId, factId: schema.findingEvidence.factId, communicationId: schema.findingEvidence.communicationId, documentId: schema.findingEvidence.documentId })
    .from(schema.findingEvidence)
    .where(inArray(schema.findingEvidence.findingId, d.select({ id: schema.findings.id }).from(schema.findings).where(live)))
    .all();
  const byFinding = new Map<string, typeof evidence>();
  for (const e of evidence) {
    if (!byFinding.has(e.findingId)) byFinding.set(e.findingId, []);
    byFinding.get(e.findingId)!.push(e);
  }
  return rows.map((r) => ({ id: r.id, category: r.category, titleKey: normalizeKey(r.title), evidence: evidenceIdsOf(byFinding.get(r.id) ?? []) }));
}

/**
 * The AI finding on file that a reworded draft restates: same category, at
 * least one evidence id in common, and a title close enough. The model's
 * wording drifts between passes, so without this a finding the user already
 * dismissed would come back as `new` under a slightly different title.
 */
function matchAiCandidate(candidates: AiCandidate[], category: string, title: string, evidence: Set<string>): AiCandidate | null {
  if (!evidence.size) return null;
  const key = normalizeKey(title);
  let best: AiCandidate | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    if (c.category !== category) continue;
    let shared = 0;
    for (const id of evidence) if (c.evidence.has(id)) shared++;
    if (!shared) continue;
    const identical = shared === evidence.size && shared === c.evidence.size;
    const score = textSimilarity(key, c.titleKey);
    if (score < (identical ? AI_MATCH_SIMILARITY_SAME_EVIDENCE : AI_MATCH_SIMILARITY)) continue;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Write drafts for a run. A draft whose fingerprint exists refreshes the
 * finding's text, severity, run and evidence but never its status, verdict
 * note or verdict time. New fingerprints insert with status `new`, except an
 * AI draft that restates an AI finding already on file (see
 * matchAiCandidate): that refreshes the existing row, which keeps its
 * fingerprint, status and verdict.
 */
export function applyDrafts(runId: string, origin: 'rule' | 'ai', drafts: FindingDraft[]): ApplyResult {
  const d = db();
  const result: ApplyResult = { created: 0, updated: 0, unchanged: 0, invalid: 0, droppedIds: 0, fingerprints: [], findingIds: [] };
  const seen = new Set<string>();
  const aiCandidates = origin === 'ai' ? loadAiCandidates() : [];
  /** Rows this call already wrote; a second near-identical draft in the same run is a duplicate. */
  const touched = new Set<string>();
  for (const draft of drafts) {
    if (!(FINDING_CATEGORIES as readonly string[]).includes(draft.category) || !(FINDING_SEVERITIES as readonly string[]).includes(draft.severity)) {
      result.invalid++;
      continue;
    }
    const validated = validateEvidence(draft.evidence);
    result.droppedIds += validated.droppedIds;
    if (!validated.items.some((e) => e.resolves)) {
      result.invalid++;
      continue;
    }
    const fingerprint = fingerprintOf(draft);
    if (seen.has(fingerprint)) continue; // the same draft twice in one run
    seen.add(fingerprint);
    const now = nowIso();
    let existing = d.select().from(schema.findings).where(eq(schema.findings.fingerprint, fingerprint)).get();
    const evidenceIds = origin === 'ai' ? evidenceIdsOf(validated.items.map((e) => ({ factId: e.factId, communicationId: e.communicationId, documentId: e.documentId ?? e.pendingCitation?.documentId ?? null }))) : new Set<string>();
    if (!existing && origin === 'ai') {
      const match = matchAiCandidate(aiCandidates, draft.category, draft.title, evidenceIds);
      if (match) {
        if (touched.has(match.id)) continue; // restates a finding this run already wrote
        existing = d.select().from(schema.findings).where(eq(schema.findings.id, match.id)).get();
      }
    }
    let id: string;
    if (existing) {
      id = existing.id;
    } else {
      id = newId();
      d.insert(schema.findings)
        .values({ id, category: draft.category, title: draft.title, whyItMatters: draft.whyItMatters, detail: draft.detail, severity: draft.severity, status: 'new', origin, ruleId: draft.ruleId, fingerprint, runId, createdAt: now, updatedAt: now })
        .run();
      if (origin === 'ai') aiCandidates.push({ id, category: draft.category, titleKey: normalizeKey(draft.title), evidence: evidenceIds });
    }
    touched.add(id);
    const rows = validated.items.map((e, i) => ({
      id: newId(),
      findingId: id,
      factId: e.factId,
      documentId: e.documentId ?? e.pendingCitation?.documentId ?? null,
      citationId: e.citationId ?? (e.pendingCitation ? findingCitation(id, e.pendingCitation) : null),
      communicationId: e.communicationId,
      labResultId: e.labResultId,
      note: encodeNote(e.ref, e.note),
      sortOrder: i,
    }));
    if (existing) {
      const prev = d.select().from(schema.findingEvidence).where(eq(schema.findingEvidence.findingId, id)).all();
      // An automatic clearance is not a verdict: when the rule fires again the finding reopens.
      // Only the engine's clearance line is removed; anything the user wrote below it stays.
      const reopen = existing.status === 'resolved' && (existing.verdictNote ?? '').startsWith(AUTO_CLEARED_PREFIX) ? { status: 'new', verdictNote: noteAfterReopen(existing.verdictNote), verdictAt: null } : {};
      const same = existing.title === draft.title && existing.whyItMatters === draft.whyItMatters && (existing.detail ?? '') === draft.detail && existing.severity === draft.severity && evidenceSignature(prev) === evidenceSignature(rows);
      if (same) {
        if (existing.runId !== runId || existing.deletedAt || 'status' in reopen) d.update(schema.findings).set({ runId, deletedAt: null, ...reopen }).where(eq(schema.findings.id, id)).run();
        result.unchanged++;
      } else {
        d.update(schema.findings)
          .set({ title: draft.title, whyItMatters: draft.whyItMatters, detail: draft.detail, severity: draft.severity, ruleId: draft.ruleId, origin, runId, updatedAt: now, deletedAt: null, ...reopen })
          .where(eq(schema.findings.id, id))
          .run();
        d.delete(schema.findingEvidence).where(eq(schema.findingEvidence.findingId, id)).run();
        d.insert(schema.findingEvidence).values(rows).run();
        result.updated++;
      }
    } else {
      d.insert(schema.findingEvidence).values(rows).run();
      result.created++;
    }
    const saved = d.select().from(schema.findings).where(eq(schema.findings.id, id)).get()!;
    indexFinding(saved);
    result.fingerprints.push(saved.fingerprint ?? fingerprint);
    result.findingIds.push(id);
  }
  return result;
}

/**
 * Would applyDrafts change nothing for these rule drafts? True when every valid draft already has its finding on file
 * (by fingerprint), not deleted, not waiting to reopen (an automatic clearance), with the same title, why, detail,
 * severity and evidence. `fingerprints` are the drafts' (what a run would keep open). Read-only: a pass that would
 * change nothing need not make a run row at all (the lab checks at every unlock; 2026-10 review).
 */
export function draftsAlreadyApplied(drafts: FindingDraft[]): { same: boolean; fingerprints: string[] } {
  const d = db();
  const fingerprints: string[] = [];
  for (const draft of drafts) {
    if (!(FINDING_CATEGORIES as readonly string[]).includes(draft.category) || !(FINDING_SEVERITIES as readonly string[]).includes(draft.severity)) continue;
    const validated = validateEvidence(draft.evidence);
    if (!validated.items.some((e) => e.resolves)) continue;
    // A citation made from the draft (pendingCitation) is written by applyDrafts itself: never "already applied".
    if (validated.items.some((e) => e.pendingCitation)) return { same: false, fingerprints };
    const fingerprint = fingerprintOf(draft);
    fingerprints.push(fingerprint);
    const existing = d.select().from(schema.findings).where(eq(schema.findings.fingerprint, fingerprint)).get();
    if (!existing || existing.deletedAt) return { same: false, fingerprints };
    if (existing.status === 'resolved' && (existing.verdictNote ?? '').startsWith(AUTO_CLEARED_PREFIX)) return { same: false, fingerprints };
    const prev = d.select().from(schema.findingEvidence).where(eq(schema.findingEvidence.findingId, existing.id)).all();
    const rows = validated.items.map((e) => ({ factId: e.factId, documentId: e.documentId ?? null, citationId: e.citationId ?? null, communicationId: e.communicationId, labResultId: e.labResultId, note: encodeNote(e.ref, e.note) }));
    const same = existing.title === draft.title && existing.whyItMatters === draft.whyItMatters && (existing.detail ?? '') === draft.detail && existing.severity === draft.severity && evidenceSignature(prev) === evidenceSignature(rows);
    if (!same) return { same: false, fingerprints };
  }
  return { same: true, fingerprints };
}

/**
 * Rule findings still `new` that this (unscoped) run did not reproduce are no
 * longer detected: mark them resolved with a note. Judged findings are left
 * exactly as they are, and so is a `new` finding carrying a note the user
 * wrote: the note is the user's own record, so the engine neither overwrites
 * it nor decides the finding for them.
 */
export function retireStaleRuleFindings(runId: string, activeFingerprints: Iterable<string>, ruleIds: string[] = CROSSREF_RULE_IDS): number {
  const d = db();
  const active = new Set(activeFingerprints);
  const stale = d
    .select({ id: schema.findings.id, fingerprint: schema.findings.fingerprint, verdictNote: schema.findings.verdictNote })
    .from(schema.findings)
    .where(and(eq(schema.findings.origin, 'rule'), eq(schema.findings.status, 'new'), isNull(schema.findings.deletedAt), inArray(schema.findings.ruleId, ruleIds)))
    .all()
    .filter((f) => (!f.fingerprint || !active.has(f.fingerprint)) && !isUserNote(f.verdictNote));
  const now = nowIso();
  for (const f of stale) {
    d.update(schema.findings)
      // The run's day in the case's local time (TZ), never UTC: an evening run west of UTC is not "tomorrow" (2026-10-09).
      .set({ status: 'resolved', verdictAt: now, verdictNote: `${AUTO_CLEARED_PREFIX} not detected by the rules run of ${todayIso()}.`, runId, updatedAt: now })
      .where(eq(schema.findings.id, f.id))
      .run();
    // The note changed: keep the search entry in step with it.
    indexFinding(d.select().from(schema.findings).where(eq(schema.findings.id, f.id)).get()!);
  }
  return stale.length;
}

/**
 * The rule findings about one fact that nobody judged (status `new`, no note of the user's) are resolved with the
 * engine's clearance line (2026-10-09, lab check: a value the app added from a page and the user took back with Undo; the
 * rules had raised e.g. "abnormal result never mentioned again" about it by themselves). A finding the user judged or
 * wrote a note on is left exactly as it is. The next rules run reopens one that is still detected. Returns how many.
 */
export function clearUnjudgedRuleFindingsOfFact(factId: string, why: string): number {
  const d = db();
  const open = d
    .all<{ id: string; verdictNote: string | null }>(sql`
      select distinct fi.id as id, fi.verdict_note as verdictNote from findings fi join finding_evidence fe on fe.finding_id = fi.id
      where fe.fact_id = ${factId} and fi.deleted_at is null and fi.origin = 'rule' and fi.status = 'new'`)
    .filter((f) => !isUserNote(f.verdictNote));
  const now = nowIso();
  for (const f of open) {
    d.update(schema.findings).set({ status: 'resolved', verdictAt: now, verdictNote: `${AUTO_CLEARED_PREFIX} ${why}`, updatedAt: now }).where(eq(schema.findings.id, f.id)).run();
    indexFinding(d.select().from(schema.findings).where(eq(schema.findings.id, f.id)).get()!);
  }
  return open.length;
}

/**
 * Resolve every open finding of these rules, whatever its fingerprint, with
 * the engine's clearance line ("Cleared automatically: <why>"): for a rule
 * that no longer drafts findings (the clinical-record disagreements, now on
 * the Reconciliation page). As in retireStaleRuleFindings, a finding the user
 * judged, or an open one carrying a note the user wrote, is left as it is. The
 * finding keeps its run. Returns how many were resolved.
 */
export function resolveRuleFindings(ruleIds: string[], why: string): number {
  if (!ruleIds.length) return 0;
  const d = db();
  const open = d
    .select({ id: schema.findings.id, verdictNote: schema.findings.verdictNote })
    .from(schema.findings)
    .where(and(eq(schema.findings.origin, 'rule'), eq(schema.findings.status, 'new'), isNull(schema.findings.deletedAt), inArray(schema.findings.ruleId, ruleIds)))
    .all()
    .filter((f) => !isUserNote(f.verdictNote));
  const now = nowIso();
  for (const f of open) {
    d.update(schema.findings).set({ status: 'resolved', verdictAt: now, verdictNote: `${AUTO_CLEARED_PREFIX} ${why}`, updatedAt: now }).where(eq(schema.findings.id, f.id)).run();
    indexFinding(d.select().from(schema.findings).where(eq(schema.findings.id, f.id)).get()!);
  }
  return open.length;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** What the AI pass returned and what it kept, stored on the run (inside scope_json) so the Runs view can show drops. */
export interface AiRunStats {
  returned: number;
  kept: number;
  droppedNoEvidence: number;
  droppedWording: number;
  droppedIds: number;
}

/** The run's scope_json: the scope itself plus how the run was started and, once the AI pass finishes, its counts. */
export interface RunScope extends CrossrefScope {
  rulesOnly?: boolean;
  /** Set by the incremental patient-precedence pass (services/precedence.ts). */
  trigger?: string;
  rule?: string;
  aiStats?: AiRunStats;
}

export interface RunUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedUsd: number;
  durationMs: number;
}

export type RunWithUsage = RunRow & { usage: RunUsage; scope: CrossrefScope & { trigger?: string; rule?: string }; rulesOnly: boolean; aiCallIds: string[]; aiStats: AiRunStats | null };

export interface RunDetail extends RunWithUsage {
  findings: Array<Pick<FindingRow, 'id' | 'title' | 'category' | 'severity' | 'status' | 'origin' | 'ruleId'>>;
  job: { id: string; status: string; progress: number; progressText: string | null; error: string | null } | null;
}

export function isScoped(scope: CrossrefScope): boolean {
  return Boolean(scope.documentIds?.length || scope.from || scope.to);
}

function safeModel(deep: boolean): string | null {
  try {
    return modelFor(deep);
  } catch {
    return null;
  }
}

export function createRun(opts: { deep?: boolean; rulesOnly?: boolean; scope?: CrossrefScope }): RunRow {
  const d = db();
  const id = newId();
  const scope: RunScope = { ...(opts.scope ?? {}), rulesOnly: Boolean(opts.rulesOnly) };
  d.insert(schema.crossrefRuns)
    .values({ id, startedAt: nowIso(), model: opts.rulesOnly ? null : safeModel(Boolean(opts.deep)), deep: Boolean(opts.deep), scopeJson: JSON.stringify(scope), status: 'running' })
    .run();
  return getRunRow(id)!;
}

export function getRunRow(id: string): RunRow | null {
  return db().select().from(schema.crossrefRuns).where(eq(schema.crossrefRuns.id, id)).get() ?? null;
}

export function runScope(run: RunRow): RunScope {
  return parseJson<RunScope>(run.scopeJson, {});
}

function countFindingsOfRun(runId: string): number {
  return db().get<{ n: number }>(sql`select count(*) as n from findings where run_id = ${runId} and deleted_at is null`)?.n ?? 0;
}

export interface RulesSummary extends ApplyResult {
  drafts: number;
  retired: number;
}

/** Run every deterministic rule for a run, write the results, and record the counts on the run. */
export function runRulesForRun(runId: string, opts: { today?: string } = {}): RulesSummary {
  const run = getRunRow(runId);
  if (!run) throw notFound('run not found');
  const scope = runScope(run);
  const ctx = buildRuleContext({ documentIds: scope.documentIds, from: scope.from, to: scope.to }, opts.today ?? todayIso());
  const drafts = runAllRules(ctx);
  const applied = applyDrafts(runId, 'rule', drafts);
  const retired = isScoped(scope) ? 0 : retireStaleRuleFindings(runId, applied.fingerprints);
  db().update(schema.crossrefRuns)
    .set({ rulesCount: applied.created + applied.updated + applied.unchanged, findingsCount: countFindingsOfRun(runId) })
    .where(eq(schema.crossrefRuns.id, runId))
    .run();
  return { ...applied, drafts: drafts.length, retired };
}

export function finishRun(runId: string, patch: { status: 'done' | 'failed'; error?: string | null; aiCallIds?: string[]; aiStats?: AiRunStats } = { status: 'done' }): RunRow {
  const run = getRunRow(runId);
  if (!run) throw notFound('run not found');
  const ids = [...parseJson<string[]>(run.aiCallIdsJson, []), ...(patch.aiCallIds ?? [])];
  const scopeJson = patch.aiStats ? JSON.stringify({ ...runScope(run), aiStats: patch.aiStats }) : run.scopeJson;
  db().update(schema.crossrefRuns)
    .set({ status: patch.status, finishedAt: nowIso(), error: patch.error ? patch.error.slice(0, 2000) : null, aiCallIdsJson: JSON.stringify(ids), scopeJson, findingsCount: countFindingsOfRun(runId) })
    .where(eq(schema.crossrefRuns.id, runId))
    .run();
  return getRunRow(runId)!;
}

function usageFor(aiCallIds: string[]): RunUsage {
  const empty: RunUsage = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0, durationMs: 0 };
  if (!aiCallIds.length) return empty;
  const rows = db().select().from(schema.aiCalls).where(inArray(schema.aiCalls.id, aiCallIds)).all();
  for (const r of rows) {
    empty.calls++;
    empty.inputTokens += r.inputTokens;
    empty.outputTokens += r.outputTokens;
    empty.cacheReadTokens += r.cacheReadTokens;
    empty.cacheWriteTokens += r.cacheWriteTokens;
    empty.estimatedUsd += r.estimatedUsd;
    empty.durationMs += r.durationMs;
  }
  return empty;
}

function withUsage(run: RunRow): RunWithUsage {
  const scope = runScope(run);
  const aiCallIds = parseJson<string[]>(run.aiCallIdsJson, []);
  const { rulesOnly, aiStats, ...rest } = scope;
  return { ...run, usage: usageFor(aiCallIds), scope: rest, rulesOnly: Boolean(rulesOnly), aiCallIds, aiStats: aiStats ?? null };
}

export function listRuns(limit = 50): RunWithUsage[] {
  return db()
    .select()
    .from(schema.crossrefRuns)
    .orderBy(desc(schema.crossrefRuns.startedAt))
    .limit(Math.max(1, Math.min(limit, 500)))
    .all()
    .map(withUsage);
}

/** high, medium, low, then info (a plain sort on the text would put high last). */
const SEVERITY_RANK = sql`case ${schema.findings.severity} when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end`;

export function getRun(id: string): RunDetail {
  const run = getRunRow(id);
  if (!run) throw notFound('run not found');
  const d = db();
  const findings = d
    .select({ id: schema.findings.id, title: schema.findings.title, category: schema.findings.category, severity: schema.findings.severity, status: schema.findings.status, origin: schema.findings.origin, ruleId: schema.findings.ruleId })
    .from(schema.findings)
    .where(and(eq(schema.findings.runId, id), isNull(schema.findings.deletedAt)))
    .orderBy(SEVERITY_RANK, schema.findings.title)
    .all();
  const job =
    d
      .select({ id: schema.jobs.id, status: schema.jobs.status, progress: schema.jobs.progress, progressText: schema.jobs.progressText, error: schema.jobs.error })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.type, 'crossref'), like(schema.jobs.payloadJson, `%${id}%`)))
      .orderBy(desc(schema.jobs.createdAt))
      .get() ?? null;
  return { ...withUsage(run), findings, job };
}

// ---------------------------------------------------------------------------
// Reading findings
// ---------------------------------------------------------------------------

export interface ListFindingsParams {
  category?: string;
  status?: string;
  severity?: string;
  q?: string;
  origin?: string;
  runId?: string;
  ruleId?: string;
  limit?: number;
}

export type FindingListItem = FindingRow & { evidenceCount: number; runStartedAt: string | null };

export function listFindings(p: ListFindingsParams = {}): { items: FindingListItem[]; total: number } {
  const d = db();
  const f = schema.findings;
  const conds: SQL[] = [isNull(f.deletedAt)];
  if (p.category) conds.push(eq(f.category, p.category));
  const statuses = (p.status ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (statuses.length) conds.push(inArray(f.status, statuses));
  const severities = (p.severity ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (severities.length) conds.push(inArray(f.severity, severities));
  if (p.origin) conds.push(eq(f.origin, p.origin));
  if (p.runId) conds.push(eq(f.runId, p.runId));
  if (p.ruleId) conds.push(eq(f.ruleId, p.ruleId));
  const q = (p.q ?? '').trim();
  if (q) {
    const pat = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    conds.push(or(sql`${f.title} like ${pat} escape '\\'`, sql`${f.whyItMatters} like ${pat} escape '\\'`, sql`${f.detail} like ${pat} escape '\\'`, sql`${f.ruleId} like ${pat} escape '\\'`)!);
  }
  const items = d
    .select({
      id: f.id,
      category: f.category,
      title: f.title,
      whyItMatters: f.whyItMatters,
      detail: f.detail,
      severity: f.severity,
      status: f.status,
      verdictNote: f.verdictNote,
      verdictAt: f.verdictAt,
      origin: f.origin,
      ruleId: f.ruleId,
      fingerprint: f.fingerprint,
      runId: f.runId,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      deletedAt: f.deletedAt,
      evidenceCount: sql<number>`(select count(*) from finding_evidence fe where fe.finding_id = ${f.id})`.mapWith(Number),
      runStartedAt: schema.crossrefRuns.startedAt,
    })
    .from(f)
    .leftJoin(schema.crossrefRuns, eq(schema.crossrefRuns.id, f.runId))
    .where(and(...conds))
    .orderBy(sql`case ${f.status} when 'new' then 0 when 'confirmed' then 1 when 'disputed' then 2 when 'resolved' then 3 else 4 end`, SEVERITY_RANK, desc(f.updatedAt))
    .limit(Math.max(1, Math.min(p.limit ?? 2000, 10000)))
    .all();
  return { items, total: items.length };
}

export function findingCounts(): { byStatus: Record<string, number>; byCategory: Record<string, number>; bySeverity: Record<string, number> } {
  const d = db();
  const out = { byStatus: {} as Record<string, number>, byCategory: {} as Record<string, number>, bySeverity: {} as Record<string, number> };
  for (const r of d.all<{ k: string; n: number }>(sql`select status as k, count(*) as n from findings where deleted_at is null group by status`)) out.byStatus[r.k] = r.n;
  for (const r of d.all<{ k: string; n: number }>(sql`select category as k, count(*) as n from findings where deleted_at is null group by category`)) out.byCategory[r.k] = r.n;
  for (const r of d.all<{ k: string; n: number }>(sql`select severity as k, count(*) as n from findings where deleted_at is null and status in ('new','confirmed') group by severity`)) out.bySeverity[r.k] = r.n;
  return out;
}

export interface EvidenceItem {
  id: string;
  sortOrder: number;
  note: string | null;
  factId: string | null;
  citationId: string | null;
  documentId: string | null;
  communicationId: string | null;
  labResultId: string | null;
  ref: EvidenceRef | null;
  fact: { id: string; statement: string; type: string; status: string; date: string | null; datePrecision: string; dateText: string | null; sourceDocumentId: string | null; documentTitle: string | null } | null;
  citation: { id: string; documentId: string; pageNumber: number; quote: string; verified: boolean; matchKind: string | null; documentTitle: string | null } | null;
  communication: { id: string; subject: string; occurredAt: string | null; occurredAtPrecision: string; direction: string; channel: string; followUpPromised: string | null; followUpDue: string | null; followUpDoneAt: string | null } | null;
  /**
   * A lab row named as evidence: its current value, unit, range and flag, and (2026-10, migration 0004) the text as printed
   * (valueRaw, refRaw, flagRaw: '' or '-' is "no flag printed"; null when not recorded), shown as printed.
   */
  lab: {
    id: string;
    analyte: string;
    valueNum: number | null;
    valueText: string | null;
    unit: string | null;
    flag: string | null;
    specimen: string;
    collectedAt: string | null;
    collectedAtPrecision: string;
    documentId: string | null;
    refText?: string | null;
    valueRaw?: string | null;
    flagRaw?: string | null;
    refRaw?: string | null;
    resultedAt?: string | null;
    /**
     * The value is the user's own (changed by hand: parse_json.userFields names it, or a row saved by hand before that
     * record existed holds other text than printed): only then is the printed text said beside it ("as printed: 0.8").
     */
    valueEdited?: boolean;
  } | null;
  document: { id: string; title: string; documentDate: string | null; documentDatePrecision: string; category: string } | null;
  record: { id: string; title: string; status: string; recordType: string } | null;
  medication: { id: string; name: string; status: string } | null;
  medicationEvent: { id: string; medicationId: string; medicationName: string; kind: string; date: string | null } | null;
  symptom: { id: string; name: string } | null;
  encounter: { id: string; title: string; status: string; occurredAt: string | null } | null;
  task: { id: string; title: string; status: string } | null;
}

export interface FindingDetail extends FindingRow {
  evidence: EvidenceItem[];
  run: Pick<RunRow, 'id' | 'startedAt' | 'finishedAt' | 'model' | 'deep' | 'status'> | null;
  tasks: Array<{ id: string; title: string; status: string; dueAt: string | null }>;
}

/** A lab row's value is the user's own: the record of changed fields names it, or (rows saved before it existed) the row was saved by hand and holds other text than printed. */
function labValueEdited(l: { parseJson: string | null; createdAt: string; updatedAt: string; valueText: string | null; valueRaw: string | null }): boolean {
  const pj = parseJson<{ userFields?: unknown } | null>(l.parseJson, null);
  if (pj && Array.isArray(pj.userFields)) return pj.userFields.includes('value');
  return l.createdAt !== l.updatedAt && Boolean(l.valueRaw && l.valueText && l.valueRaw.trim() !== l.valueText.trim());
}

function expandEvidence(rows: EvidenceRow[]): EvidenceItem[] {
  const d = db();
  const docTitle = (id: string | null): string | null => (id ? (d.select({ title: schema.documents.title }).from(schema.documents).where(eq(schema.documents.id, id)).get()?.title ?? null) : null);
  return rows
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => {
      const { ref, note } = decodeNote(r.note);
      const item: EvidenceItem = { id: r.id, sortOrder: r.sortOrder, note, factId: r.factId, citationId: r.citationId, documentId: r.documentId, communicationId: r.communicationId, labResultId: r.labResultId, ref, fact: null, citation: null, communication: null, lab: null, document: null, record: null, medication: null, medicationEvent: null, symptom: null, encounter: null, task: null };
      if (r.factId) {
        const f = d.select().from(schema.facts).where(eq(schema.facts.id, r.factId)).get();
        if (f) item.fact = { id: f.id, statement: f.statement, type: f.type, status: f.status, date: f.date, datePrecision: f.datePrecision, dateText: f.dateText, sourceDocumentId: f.sourceDocumentId, documentTitle: docTitle(f.sourceDocumentId) };
      }
      if (r.citationId) {
        const c = d.select().from(schema.citations).where(eq(schema.citations.id, r.citationId)).get();
        if (c) item.citation = { id: c.id, documentId: c.documentId, pageNumber: c.pageNumber, quote: c.quote, verified: Boolean(c.verified), matchKind: c.matchKind, documentTitle: docTitle(c.documentId) };
      }
      if (r.communicationId) {
        const c = d.select().from(schema.communications).where(eq(schema.communications.id, r.communicationId)).get();
        if (c) item.communication = { id: c.id, subject: c.subject, occurredAt: c.occurredAt, occurredAtPrecision: c.occurredAtPrecision, direction: c.direction, channel: c.channel, followUpPromised: c.followUpPromised, followUpDue: c.followUpDue, followUpDoneAt: c.followUpDoneAt };
      }
      if (r.labResultId) {
        const l = d.select().from(schema.labResults).where(eq(schema.labResults.id, r.labResultId)).get();
        if (l)
          item.lab = {
            id: l.id,
            analyte: l.analyte,
            valueNum: l.valueNum,
            valueText: l.valueText,
            unit: l.unit,
            flag: l.flag,
            specimen: l.specimen,
            collectedAt: l.collectedAt,
            collectedAtPrecision: l.collectedAtPrecision,
            documentId: l.documentId,
            refText: l.refText,
            valueRaw: l.valueRaw,
            flagRaw: l.flagRaw,
            refRaw: l.refRaw,
            resultedAt: l.resultedAt,
            valueEdited: labValueEdited(l),
          };
      }
      if (r.documentId) {
        const doc = d.select().from(schema.documents).where(eq(schema.documents.id, r.documentId)).get();
        if (doc) item.document = { id: doc.id, title: doc.title, documentDate: doc.documentDate, documentDatePrecision: doc.documentDatePrecision, category: doc.category };
      }
      if (ref) {
        switch (ref.kind) {
          case 'record': {
            const x = d.select().from(schema.recordsInventory).where(eq(schema.recordsInventory.id, ref.id)).get();
            if (x) item.record = { id: x.id, title: x.title, status: x.status, recordType: x.recordType };
            break;
          }
          case 'medication': {
            const x = d.select().from(schema.medications).where(eq(schema.medications.id, ref.id)).get();
            if (x) item.medication = { id: x.id, name: x.name, status: x.status };
            break;
          }
          case 'medication_event': {
            const x = d.select().from(schema.medicationEvents).where(eq(schema.medicationEvents.id, ref.id)).get();
            if (x) {
              const m = d.select({ name: schema.medications.name }).from(schema.medications).where(eq(schema.medications.id, x.medicationId)).get();
              item.medicationEvent = { id: x.id, medicationId: x.medicationId, medicationName: m?.name ?? '', kind: x.kind, date: x.date };
            }
            break;
          }
          case 'symptom': {
            const x = d.select().from(schema.symptomDefinitions).where(eq(schema.symptomDefinitions.id, ref.id)).get();
            if (x) item.symptom = { id: x.id, name: x.name };
            break;
          }
          case 'encounter': {
            const x = d.select().from(schema.encounters).where(eq(schema.encounters.id, ref.id)).get();
            if (x) item.encounter = { id: x.id, title: x.title, status: x.status, occurredAt: x.occurredAt };
            break;
          }
          case 'task': {
            const x = d.select().from(schema.tasks).where(eq(schema.tasks.id, ref.id)).get();
            if (x) item.task = { id: x.id, title: x.title, status: x.status };
            break;
          }
        }
      }
      return item;
    });
}

export function getFindingRow(id: string): FindingRow | null {
  return db().select().from(schema.findings).where(and(eq(schema.findings.id, id), isNull(schema.findings.deletedAt))).get() ?? null;
}

export function getFinding(id: string): FindingDetail {
  const f = getFindingRow(id);
  if (!f) throw notFound('finding not found');
  const d = db();
  const evidence = expandEvidence(d.select().from(schema.findingEvidence).where(eq(schema.findingEvidence.findingId, id)).all());
  const run = f.runId
    ? d.select({ id: schema.crossrefRuns.id, startedAt: schema.crossrefRuns.startedAt, finishedAt: schema.crossrefRuns.finishedAt, model: schema.crossrefRuns.model, deep: schema.crossrefRuns.deep, status: schema.crossrefRuns.status }).from(schema.crossrefRuns).where(eq(schema.crossrefRuns.id, f.runId)).get() ?? null
    : null;
  const tasks = d
    .select({ id: schema.tasks.id, title: schema.tasks.title, status: schema.tasks.status, dueAt: schema.tasks.dueAt })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.sourceType, 'finding'), eq(schema.tasks.sourceId, id), isNull(schema.tasks.deletedAt)))
    .all();
  return { ...f, evidence, run, tasks };
}

// ---------------------------------------------------------------------------
// Verdicts and tasks
// ---------------------------------------------------------------------------

export function setFindingVerdict(id: string, status: FindingStatus, note?: string | null): FindingDetail {
  if (!(FINDING_STATUSES as readonly string[]).includes(status)) throw badRequest(`status must be one of ${FINDING_STATUSES.join(', ')}`);
  const f = getFindingRow(id);
  if (!f) throw notFound('finding not found');
  const now = nowIso();
  const set: Partial<typeof schema.findings.$inferInsert> = { status, updatedAt: now, verdictAt: status === 'new' ? null : now };
  if (note !== undefined) set.verdictNote = note && note.trim() ? note.trim() : null;
  db().update(schema.findings).set(set).where(eq(schema.findings.id, id)).run();
  // The verdict note is searchable: a changed (or cleared) note rewrites the entry.
  if (note !== undefined) indexFinding(getFindingRow(id)!);
  return getFinding(id);
}

export interface ToTaskInput {
  title?: string | null;
  detail?: string | null;
  owner?: string | null;
  ownerPersonId?: string | null;
  dueAt?: string | null;
  priority?: string | null;
}

export type TaskRow = typeof schema.tasks.$inferSelect;

/** Create an open task from a finding (one open task per finding; a second call returns the existing one). */
export function findingToTask(id: string, input: ToTaskInput = {}): TaskRow & { existing: boolean } {
  const f = getFindingRow(id);
  if (!f) throw notFound('finding not found');
  const d = db();
  const open = d
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.sourceType, 'finding'), eq(schema.tasks.sourceId, id), isNull(schema.tasks.deletedAt), inArray(schema.tasks.status, ['open', 'in_progress'])))
    .get();
  if (open) return { ...open, existing: true };
  const now = nowIso();
  const row: typeof schema.tasks.$inferInsert = {
    id: newId(),
    title: (input.title ?? '').trim() || f.title,
    detail: (input.detail ?? '').trim() || f.whyItMatters,
    owner: input.owner ?? 'me',
    ownerPersonId: input.ownerPersonId ?? null,
    dueAt: input.dueAt ?? null,
    status: 'open',
    priority: input.priority ?? (f.severity === 'high' ? 'high' : 'normal'),
    sourceType: 'finding',
    sourceId: id,
    createdAt: now,
    updatedAt: now,
  };
  d.insert(schema.tasks).values(row).run();
  const saved = d.select().from(schema.tasks).where(eq(schema.tasks.id, row.id)).get()!;
  indexEntity('task', saved.id, saved.title, saved.detail);
  return { ...saved, existing: false };
}
