/**
 * The lab checks (the user's rules 10 and 12, 2026-10): two deterministic rules stored as findings.
 *
 * - `lab_same_source_conflict` (rule 10): one document gives two values of one test, sample and day that differ like a
 *   typing error: a decimal point (0.08 and 0.8), a dropped sign ("<3" and "3") or two swapped digits (62 and 26).
 *   Neither value is chosen or changed; the finding names both values and both pages.
 * - `lab_claim_differs` (rule 12): a document that restates results (a summary, a patient note, an external letter)
 *   judges a value, or names a limit, otherwise than the lab report printed. One finding per (that document, the lab
 *   report) pair, listing every difference (amendment G4). The record is never changed and the claim never set aside
 *   here (the reconciliation compares the values themselves).
 * - `lab_computed_differs` (2026-10-09): the lab prints an index (albumin index, IgG index) for the same collection day as
 *   One the patient computed, and the two differ at the lab's precision (services/lab-compute-check.ts). Unscoped runs only.
 *
 * One loader and one draft builder (amendment G1): the values come from labs.ts `loadLabReadings()` (the Labs page's
 * own entries, set-aside ones left out; for rule 12 also a summary's claims the reconciliation set aside as matched with
 * a lab report, marked `passSetAside`: the reconciliation runs first, and a claim that restates the lab's value is
 * still that summary's judgement or limit; 2026-10 review) and `labCheckDrafts` builds the drafts for both paths: `runLabChecks` (after an
 * extraction, at every unlock) and the two CrossrefRules a full Findings run executes (crossref-rules.ts), which read the
 * same loader through the context. Fingerprints are stable, so re-runs update instead of duplicating and never touch a
 * verdict (findings.ts applyDrafts); a dismissed finding stays dismissed.
 *
 * After an extraction only rule 10 runs, for that document, and only that document's open rule-10 findings that no
 * longer hold are cleared; rule 12 and the full clearing run at unlock and in a full Findings run (amendment G4).
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { loadLabReadings } from './labs';
import { applyDrafts, createRun, draftsAlreadyApplied, finishRun, isUserNote, retireStaleRuleFindings } from './findings';
import { inScopeWindow, type CrossrefScope, type DraftEvidence, type FindingDraft, type RuleContext } from './crossref-rules';
import { findClaimDifferences, findSameSourceConflicts, type CheckItem, type ClaimDifference, type ConflictKind, type SameSourceConflict } from '../../shared/labvalues';
import type { LabReadingRecord } from './lab-reading';
import { computedDiffersDrafts } from './lab-compute-check';
import { COMPUTED_DIFFERS_RULE } from '../../shared/labcompute';

/** Rule 10: one document, two values of one test that differ like a typing error. Equal to labs.ts LAB_ISSUE_RULES[0]. */
export const LAB_SAME_SOURCE_RULE = 'lab_same_source_conflict';
/** Rule 12: a document's own judgement or limit differs from the lab report's. Equal to labs.ts LAB_ISSUE_RULES[1]. */
export const LAB_CLAIM_RULE = 'lab_claim_differs';
/** A printed index differs from the one the patient computed for the same collection (2026-10-09, worded like rule 12). */
export const LAB_COMPUTED_RULE = COMPUTED_DIFFERS_RULE;
export const LAB_CHECK_RULE_IDS: string[] = [LAB_SAME_SOURCE_RULE, LAB_CLAIM_RULE, LAB_COMPUTED_RULE];

export type LabCheck = 'conflict' | 'claim' | 'computed';

export interface LabCheckOutput {
  /** Rule 10 pairs found (after the scope). */
  conflicts: SameSourceConflict[];
  /** Rule 12 differences found (after the scope). */
  claims: ClaimDifference[];
  drafts: FindingDraft[];
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/** The value as shown with its unit ("0.08", "62 mg/dL", "<3 cells/uL"). */
function valueWords(i: CheckItem): string {
  const u = i.reading.unit.unit;
  return `${i.reading.valueShown || 'no value'}${u ? ` ${u}` : ''}`;
}

function pageWords(i: CheckItem): string {
  return i.pageNumber != null ? ` (page ${i.pageNumber})` : '';
}

/** An evidence item for one side: the fact or lab row, its page, its document; the value as shown. */
function evidenceOf(i: CheckItem, note: string): DraftEvidence {
  return { factId: i.factId, labResultId: i.labResultId, citationId: i.citationId, documentId: i.documentId, note };
}

/** CheckItems for the pure finders (src/shared/labvalues.ts): the loader's records as they are. */
export function checkItemsOf(records: readonly LabReadingRecord[]): CheckItem[] {
  return records
    .filter((r) => r.analyteKey)
    .map((r) => ({
      id: r.id,
      factId: r.factId,
      labResultId: r.labResultId,
      documentId: r.documentId,
      documentTitle: r.documentTitle,
      documentTier: r.documentTier,
      pageNumber: r.pageNumber,
      citationId: r.citationId,
      analyte: r.analyte,
      analyteKey: r.analyteKey,
      specimen: r.specimen,
      reading: r.reading,
      quote: r.quote ?? null,
    }));
}

const KIND_WHY: Record<ConflictKind, string> = {
  decimal_shift: 'The two values differ only by where the decimal point sits, which is how a typing error looks.',
  symbol_dropped: 'The two values differ only by the sign in front of the number ("<", ">"): one of them may have lost it in copying, and a limit is not a measurement.',
  digit_swap: 'The two values differ only by two swapped digits, which is how a typing error looks.',
};

function conflictDraft(c: SameSourceConflict): FindingDraft {
  const doc = c.a.documentTitle ?? 'This document';
  const values = [c.a.reading.valueShown, c.b.reading.valueShown].sort();
  return {
    ruleId: LAB_SAME_SOURCE_RULE,
    category: 'discrepancy',
    severity: c.kind === 'digit_swap' ? 'low' : 'medium',
    title: clip(`${c.a.analyte}: one document gives ${valueWords(c.a)} and ${valueWords(c.b)}${c.date ? ` on ${c.date}` : ''}`, 140),
    whyItMatters: `${KIND_WHY[c.kind]} One document gives both for the same test, sample and day, so one of them may be wrong. Neither value was chosen or changed here; the original lab report, or the lab itself, can say which is right.`,
    detail: [c.words, `Both in "${doc}": ${valueWords(c.a)}${pageWords(c.a)}; ${valueWords(c.b)}${pageWords(c.b)}.`].join('\n'),
    evidence: [evidenceOf(c.a, `${valueWords(c.a)} as written${pageWords(c.a)}`), evidenceOf(c.b, `${valueWords(c.b)} as written${pageWords(c.b)}`)],
    key: [c.documentId, c.analyteKey, c.specimen, c.date ?? '', ...values],
  };
}

/** The claim's own words for a line of evidence: its value, and its judgement or limit as written. */
function claimNote(i: CheckItem): string {
  const words = [i.reading.claim?.interpretation, i.reading.claim?.limitUsed ? `limit ${i.reading.claim.limitUsed}` : null, i.reading.rangeShown ? `range ${i.reading.rangeShown}` : null].filter(Boolean).join('; ');
  return `this document's claim: ${valueWords(i)}${words ? ` (${words})` : ''}${pageWords(i)}`;
}

function recordNote(i: CheckItem): string {
  const flag = i.reading.flag.state === 'flag' ? `flag ${(i.reading.flag.raw ?? '').trim() || i.reading.flag.printed}` : i.reading.computed.flag ? `${i.reading.computed.flag} by its own range` : null;
  const range = i.reading.rangeShown ? `range ${i.reading.rangeShown}` : 'no range printed';
  return `the lab report: ${valueWords(i)} (${[range, flag].filter(Boolean).join('; ')})${pageWords(i)}`;
}

function claimDrafts(diffs: ClaimDifference[]): FindingDraft[] {
  const groups = new Map<string, ClaimDifference[]>();
  for (const d of diffs) {
    const k = `${d.claim.documentId ?? ''}\u0001${d.record.documentId ?? ''}`;
    const list = groups.get(k);
    if (list) list.push(d);
    else groups.set(k, [d]);
  }
  const out: FindingDraft[] = [];
  for (const unsorted of groups.values()) {
    // In a stable order (test, then date), so a re-run writes the same text and the finding reads unchanged.
    const list = [...unsorted].sort((x, y) => x.claim.analyte.localeCompare(y.claim.analyte) || (x.claim.reading.dates.reading?.iso ?? '').localeCompare(y.claim.reading.dates.reading?.iso ?? '') || x.words.localeCompare(y.words));
    const first = list[0];
    const claimDoc = first.claim.documentTitle ?? 'A document';
    const recordDoc = first.record.documentTitle ?? 'the lab report';
    const judgement = list.some((d) => d.kind === 'judgement_differs');
    const claims = new Set(list.map((d) => d.claim.id));
    const n = claims.size;
    const lines = [...new Set(list.map((d) => d.words))];
    const evidence: DraftEvidence[] = [];
    const seen = new Set<string>();
    for (const d of list) {
      for (const [item, note] of [
        [d.claim, claimNote(d.claim)],
        [d.record, recordNote(d.record)],
      ] as Array<[CheckItem, string]>) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        evidence.push(evidenceOf(item, note));
      }
    }
    out.push({
      ruleId: LAB_CLAIM_RULE,
      category: 'discrepancy',
      severity: judgement ? 'medium' : 'low',
      title: clip(`"${claimDoc}" judges ${n} lab result${n === 1 ? '' : 's'} differently from "${recordDoc}"`, 140),
      whyItMatters:
        "This document restates lab results with its own judgement or limit, and it differs from what the lab report printed. The lab report's values, ranges and flags are the record; this document's words are its own claim. Nothing was changed. Worth knowing before this document is relied on or copied forward.",
      detail: lines.join('\n'),
      evidence,
      key: [first.claim.documentId ?? '', first.record.documentId ?? ''],
    });
  }
  return out;
}

/**
 * The one draft builder of the lab checks (amendment G1), for runLabChecks and the CrossrefRules alike. `rules` picks
 * the checks; a scope keeps rule 10 pairs of the scoped documents and rule 12 (document pair) findings with either
 * document in scope, and, with a date window, those with a value dated inside it (undated ones always).
 */
export function labCheckDrafts(records: readonly LabReadingRecord[], opts: { rules?: readonly LabCheck[]; scope?: CrossrefScope | null } = {}): LabCheckOutput {
  const rules = new Set<LabCheck>(opts.rules ?? ['conflict', 'claim']);
  const scope = opts.scope ?? {};
  const docs = scope.documentIds?.length ? new Set(scope.documentIds) : null;
  // Every value for rule 12 (a summary's claims the reconciliation set aside included); only the live values for rule 10.
  const items = checkItemsOf(records);
  const live = checkItemsOf(records.filter((r) => !r.passSetAside));
  const inDocs = (id: string | null) => !docs || (id != null && docs.has(id));
  const inWindow = (iso: string | null | undefined) => inScopeWindow(iso ?? null, scope);

  const conflicts = rules.has('conflict') ? findSameSourceConflicts(docs ? live.filter((i) => inDocs(i.documentId)) : live).filter((c) => inWindow(c.date)) : [];
  let claims: ClaimDifference[] = [];
  if (rules.has('claim')) {
    const all = findClaimDifferences(items).filter((d) => inDocs(d.claim.documentId) || inDocs(d.record.documentId));
    // A document pair is one finding: kept whole when any of its differences is dated inside the window.
    const pairs = new Set(all.filter((d) => inWindow(d.claim.reading.dates.reading?.iso)).map((d) => `${d.claim.documentId}\u0001${d.record.documentId}`));
    claims = all.filter((d) => pairs.has(`${d.claim.documentId}\u0001${d.record.documentId}`));
  }
  // A printed index against the one the patient computed for the same collection (services/lab-compute-check.ts).
  const computed = rules.has('computed') ? computedDiffersDrafts(records, scope) : [];
  return { conflicts, claims, drafts: [...conflicts.map(conflictDraft), ...claimDrafts(claims), ...computed] };
}

/** The drafts of one lab check over a cross-reference context (the CrossrefRules' run): none on a context built by hand. */
export function labRuleDrafts(ctx: RuleContext, check: LabCheck): FindingDraft[] {
  const records = ctx.labCheckRecords?.();
  if (!records) return [];
  return labCheckDrafts(records, { rules: [check], scope: ctx.scope }).drafts;
}

export interface LabChecksResult {
  /** The run the findings were written under; null when there was nothing to write or clear (no run row is made). */
  runId: string | null;
  created: number;
  updated: number;
  unchanged: number;
  /** Open findings of these rules that no longer hold, cleared ("Cleared automatically"). */
  retired: number;
  /** Rule 10 pairs and rule 12 differences found. */
  conflicts: number;
  claims: number;
}

/** Open (status new) rule findings of these rules: all, or those with evidence on one document. */
function openFindings(ruleIds: string[], documentId: string | null): Array<{ id: string; fingerprint: string | null; verdictNote: string | null; onDocument: boolean }> {
  const f = schema.findings;
  const rows = db()
    .select({ id: f.id, fingerprint: f.fingerprint, verdictNote: f.verdictNote })
    .from(f)
    .where(and(eq(f.origin, 'rule'), eq(f.status, 'new'), isNull(f.deletedAt), inArray(f.ruleId, ruleIds)))
    .all();
  if (!documentId || !rows.length) return rows.map((r) => ({ ...r, onDocument: true }));
  const onDoc = new Set(
    db()
      .all<{ id: string }>(sql`select distinct finding_id as id from finding_evidence where document_id = ${documentId}`)
      .map((r) => r.id),
  );
  return rows.map((r) => ({ ...r, onDocument: onDoc.has(r.id) }));
}

/**
 * Run the lab checks and store what they find as findings, under a rules-only run (modelled on
 * runPatientPrecedence). With `documentId` (after an extraction): rule 10 for that document only, and only its own open
 * rule-10 findings that no longer hold are cleared. Without: both rules over every live value, and every open finding
 * of both rules that no longer holds is cleared. A finding the user judged, or annotated, is never touched. When there
 * is nothing to write and nothing open to clear, no run row is made.
 */
export function runLabChecks(opts: { documentId?: string; trigger?: 'extraction' | 'unlock' | 'manual' } = {}): LabChecksResult {
  const documentId = opts.documentId ?? null;
  const rules: LabCheck[] = documentId ? ['conflict'] : ['conflict', 'claim', 'computed'];
  const ruleIds = documentId ? [LAB_SAME_SOURCE_RULE] : LAB_CHECK_RULE_IDS;
  // Rule 12 reads a summary's claims even once the reconciliation has set them aside (it runs first, at unlock and after
  // an extraction): a claim that restates the lab's value is still that summary's judgement or limit.
  const found = labCheckDrafts(loadLabReadings({ withPassSetAsideClaims: !documentId }), { rules, scope: documentId ? { documentIds: [documentId] } : null });
  const open = openFindings(ruleIds, documentId);
  const result: LabChecksResult = { runId: null, created: 0, updated: 0, unchanged: 0, retired: 0, conflicts: found.conflicts.length, claims: found.claims.length };
  // Nothing to write and nothing to clear (every finding already reads as drafted, no open one would be cleared): no
  // run row, so unlocking does not fill the list of past checks.
  const applied = draftsAlreadyApplied(found.drafts);
  if (applied.same) {
    const active = new Set(applied.fingerprints);
    const wouldRetire = open.some((o) => o.onDocument && (!o.fingerprint || !active.has(o.fingerprint)) && !isUserNote(o.verdictNote));
    if (!wouldRetire) {
      result.unchanged = applied.fingerprints.length;
      return result;
    }
  }

  // How the pass was started, not a scope (the pass reads every value; a documentIds here would label the run scoped).
  const scope: CrossrefScope & { trigger: string; rule: string; triggeredByDocumentId?: string } = { trigger: opts.trigger ?? 'manual', rule: 'lab_checks', ...(documentId ? { triggeredByDocumentId: documentId } : {}) };
  const run = createRun({ rulesOnly: true, scope });
  result.runId = run.id;
  try {
    const applied = applyDrafts(run.id, 'rule', found.drafts);
    // Only the findings this pass is about may be cleared: after an extraction, the other documents' stay as they are.
    const keep = [...applied.fingerprints, ...open.filter((o) => !o.onDocument && o.fingerprint).map((o) => o.fingerprint!)];
    const retired = retireStaleRuleFindings(run.id, keep, ruleIds);
    db().update(schema.crossrefRuns).set({ rulesCount: applied.created + applied.updated + applied.unchanged }).where(eq(schema.crossrefRuns.id, run.id)).run();
    finishRun(run.id, { status: 'done' });
    Object.assign(result, { created: applied.created, updated: applied.updated, unchanged: applied.unchanged, retired });
    return result;
  } catch (err) {
    finishRun(run.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
