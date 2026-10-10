/**
 * Patient precedence, run incrementally: after every extraction (and on
 * demand) the `patient_precedence` rule is evaluated over the whole ledger,
 * the overrides it decides are written to `facts.overridden_by_fact_id`
 * (through the writer attached by buildRuleContext), and its discrepancy
 * findings are upserted under a rules-only cross-reference run so they sit
 * with every other finding. Fingerprints are stable, so re-runs update
 * instead of duplicating and never touch a verdict.
 *
 * The context is always unscoped: the patient statement that outranks a
 * clinician's assessment may live in another document, and clearing a stale
 * override needs the whole picture. For the same reason the pass retires its
 * own findings that no longer hold (an override cleared by hand, a patient
 * statement disputed or deleted), exactly as a full run would; a finding
 * that fires again later reopens.
 */
import { db, schema } from '../db';
import { eq, sql } from 'drizzle-orm';
import { buildRuleContext, patientPrecedence, type CrossrefScope, type PrecedenceDecision } from './crossref-rules';
import { applyDrafts, createRun, finishRun, retireStaleRuleFindings, type ApplyResult } from './findings';
import { todayIso } from '../../shared/dates';

export interface PrecedenceRunResult {
  runId: string;
  decisions: PrecedenceDecision[];
  findings: ApplyResult;
  /** patient_precedence findings this pass marked resolved because their decision no longer holds. */
  retired: number;
  /** Facts carrying an override after the pass. */
  overridden: number;
}

/**
 * The run's scope_json. It records how the pass was started, not a scope: the
 * pass reads the whole ledger, so no documentIds (that would label the run as
 * scoped in the Runs view).
 */
type PrecedenceRunScope = CrossrefScope & { trigger: string; rule: string; triggeredByDocumentId?: string };

export function runPatientPrecedence(opts: { documentId?: string; today?: string; trigger?: 'extraction' | 'manual' } = {}): PrecedenceRunResult {
  const ctx = buildRuleContext({}, opts.today ?? todayIso());
  const scope: PrecedenceRunScope = { trigger: opts.trigger ?? 'manual', rule: patientPrecedence.id, ...(opts.documentId ? { triggeredByDocumentId: opts.documentId } : {}) };
  const run = createRun({ rulesOnly: true, scope });
  try {
    const drafts = patientPrecedence.run(ctx);
    const findings = applyDrafts(run.id, 'rule', drafts);
    const retired = retireStaleRuleFindings(run.id, findings.fingerprints, [patientPrecedence.id]);
    db().update(schema.crossrefRuns).set({ rulesCount: findings.created + findings.updated + findings.unchanged }).where(eq(schema.crossrefRuns.id, run.id)).run();
    finishRun(run.id, { status: 'done' });
    const overridden = db().get<{ n: number }>(sql`select count(*) as n from facts where overridden_by_fact_id is not null and deleted_at is null`)?.n ?? 0;
    return { runId: run.id, decisions: ctx.lastPrecedenceDecisions ?? [], findings, retired, overridden };
  } catch (err) {
    finishRun(run.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
