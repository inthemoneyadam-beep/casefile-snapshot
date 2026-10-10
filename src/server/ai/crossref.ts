/**
 * The cross-reference AI pass. The deterministic rules run first (in the
 * request, see services/findings.ts); this job hands the whole ledger to the
 * model, asks for findings in the five categories with evidence ids taken
 * from the ⟦F:…⟧ / ⟦C:…⟧ / ⟦D:… p.N⟧ tokens, validates every id against the
 * database, verifies quoted passages against page text, drops anything with
 * no usable evidence or diagnostic wording in its own voice, and upserts the
 * rest by fingerprint (or onto the AI finding on file it rewords) so a user's
 * verdict survives re-runs. The model is told which findings are on file and
 * which the patient already judged, and the run records what was dropped.
 *
 * The ledger is slice F's `buildLedger` from `services/ask-context.ts`: the
 * same sections and tokens the consult sees.
 */
import { and, desc, inArray, isNull, notInArray } from 'drizzle-orm';
import { db, schema } from '../db';
import type { JobContext } from '../jobs/queue';
import { AiDisabledError, AiRefusedError, NoApiKeyError, callStructured, type Usage } from './client';
import { CROSSREF_SYSTEM_PROMPT, buildCrossrefUserMessage, crossrefOutput, type CrossrefOutput, type FindingOnFile, type LedgerSection } from './prompts/crossref';
import { buildLedger } from '../services/ask-context';
import { AUTO_CLEARED_PREFIX, applyDrafts, finishRun, getRunRow, runScope, type AiRunStats, type ApplyResult } from '../services/findings';
import type { CrossrefScope, DraftEvidence, FindingDraft } from '../services/crossref-rules';
import { getSetting } from '../services/settings';
import { normalizeKey } from '../util/ids';
import { todayIso } from '../../shared/dates';

// ---------------------------------------------------------------------------
// Ledger (slice F's buildLedger, services/ask-context.ts)
// ---------------------------------------------------------------------------

/** The whole-case ledger with ⟦F:⟧ / ⟦C:⟧ / ⟦D:⟧ tokens, exactly as the consult sees it. */
export async function loadLedger(scope: CrossrefScope = {}): Promise<{ sections: LedgerSection[]; source: 'ask-context' }> {
  return { sections: buildLedger(scope), source: 'ask-context' };
}

// ---------------------------------------------------------------------------
// Mapping model output to drafts
// ---------------------------------------------------------------------------

/**
 * Assertive clinical claims a finding must never make in its own voice.
 * Ordinary uses of the word "diagnosis" (a label in the records) are allowed,
 * and so is "the patient had …" (history, not a claim).
 */
const DIAGNOSTIC_WORDING = [
  /\b(the )?patient (is suffering from|suffers from|is diagnosed with|(likely|probably|most likely|clearly|definitely) has)\b/i,
  /\b(the )?patient has (?!(had|not|no|never|been|received|asked|reported|requested|called|declined|already|yet|since|also|written)\b)/i,
  /\b(this|which|it) (confirms|proves|establishes|indicates|means) (a|an|the)? ?(diagnosis|disease|disorder|syndrome|condition)\b/i,
  /\b(likely|probable|definite|confirmed|presumed) (diagnosis|case) of\b/i,
  /\bdiagnosis:\s/i,
  /\bshould (be treated|start|stop|receive|be given|be prescribed)\b/i,
  /\bwe recommend (starting|stopping|treating|prescribing)\b/i,
  /\bis (consistent with|diagnostic of) (a|an) (diagnosis|disease|disorder|syndrome)\b/i,
];

/**
 * A reporting verb and the rest of its sentence: what a record or clinician
 * said, which an "overlooked" finding has to restate ("the letter says the
 * patient should start physical therapy; nothing later mentions it"). A sentence ends at
 * . ; ! ? followed by a space, or at a line break.
 */
const REPORTED_SPEECH = /\b(?:says|said|states|stated|wrote|writes|recommended|recommends|advised|advises|suggested|suggests|concluded|concludes|documented|recorded|reported|mentioned|mentions|noted|lists|listed|reads|quoted|quotes|asked|told|according to)\b(?:[^.;!?\n]|[.;!?](?=\S))*/gi;

/** The finding's own voice: quoted passages and reported speech removed. */
export function ownVoice(text: string): string {
  return text
    .replace(/"[^"\n]*"/g, ' ')
    .replace(/“[^”]*”/g, ' ')
    .replace(/‘[^’]*’/g, ' ')
    .replace(/(^|[\s([])'[^'\n]+'(?=$|[\s.,;:!?)\]])/g, '$1 ')
    .replace(REPORTED_SPEECH, ' ');
}

/** True when the finding itself (not a record it quotes or reports) diagnoses, prescribes or asserts a condition. */
export function looksLikeDiagnosis(text: string): boolean {
  const own = ownVoice(text);
  return DIAGNOSTIC_WORDING.some((re) => re.test(own));
}

export interface AiLookups {
  factIds: Set<string>;
  communicationIds: Set<string>;
  documents: Map<string, { pageCount: number }>;
}

/**
 * The ids a finding may cite. Disputed facts are left out like superseded
 * ones: the patient rejected them, so they are not evidence (the rules
 * exclude them the same way in buildRuleContext); a citation of one counts
 * in droppedIds and a finding left with nothing else is dropped.
 */
export function loadAiLookups(): AiLookups {
  const d = db();
  const factIds = new Set(d.select({ id: schema.facts.id }).from(schema.facts).where(and(isNull(schema.facts.deletedAt), notInArray(schema.facts.status, ['superseded', 'disputed']))).all().map((r) => r.id));
  const communicationIds = new Set(d.select({ id: schema.communications.id }).from(schema.communications).where(isNull(schema.communications.deletedAt)).all().map((r) => r.id));
  const documents = new Map(d.select({ id: schema.documents.id, pageCount: schema.documents.pageCount }).from(schema.documents).where(isNull(schema.documents.deletedAt)).all().map((r) => [r.id, { pageCount: r.pageCount }]));
  return { factIds, communicationIds, documents };
}

const TOKEN_RE = /^\s*[⟦\[]?\s*(?:[FCD]\s*:)?\s*([^\s⟧\]]+)(?:\s+p\.?\s*(\d+))?\s*[⟧\]]?\s*$/i;

/** Accepts a bare id, "F:id", "⟦F:id⟧" or "⟦D:id p.3⟧". */
export function parseEvidenceId(raw: string | null | undefined): { id: string; page: number | null } | null {
  if (!raw) return null;
  const m = raw.match(TOKEN_RE);
  if (!m) return null;
  return { id: m[1], page: m[2] ? Number(m[2]) : null };
}

export interface MappedOutput {
  drafts: FindingDraft[];
  returned: number;
  droppedNoEvidence: number;
  droppedWording: number;
  droppedIds: number;
}

export function mapAiOutput(output: CrossrefOutput, lookups: AiLookups): MappedOutput {
  const out: MappedOutput = { drafts: [], returned: output.findings.length, droppedNoEvidence: 0, droppedWording: 0, droppedIds: 0 };
  for (const f of output.findings) {
    const title = f.title.replace(/\s+/g, ' ').trim();
    if (!title) {
      out.droppedNoEvidence++;
      continue;
    }
    if (looksLikeDiagnosis(`${title}\n${f.why_it_matters}\n${f.detail}`)) {
      out.droppedWording++;
      continue;
    }
    const evidence: DraftEvidence[] = [];
    const ids: string[] = [];
    for (const e of f.evidence) {
      const note = e.note.trim() || null;
      const fact = parseEvidenceId(e.fact_id);
      const comm = parseEvidenceId(e.communication_id);
      const doc = parseEvidenceId(e.document_id);
      let any = false;
      const item: DraftEvidence = { note };
      if (fact) {
        if (lookups.factIds.has(fact.id)) {
          item.factId = fact.id;
          ids.push(`F:${fact.id}`);
          any = true;
        } else out.droppedIds++;
      }
      if (comm) {
        if (lookups.communicationIds.has(comm.id)) {
          item.communicationId = comm.id;
          ids.push(`C:${comm.id}`);
          any = true;
        } else out.droppedIds++;
      }
      if (doc) {
        const known = lookups.documents.get(doc.id);
        if (known) {
          const page = e.page ?? doc.page;
          const quote = (e.quote ?? '').trim();
          if (page && quote.length >= 4) {
            const pageNumber = Math.max(1, known.pageCount ? Math.min(page, known.pageCount) : page);
            item.pendingCitation = { documentId: doc.id, pageNumber, quote: quote.slice(0, 2000) };
            ids.push(`D:${doc.id}:${pageNumber}`);
          } else {
            item.documentId = doc.id;
            ids.push(`D:${doc.id}`);
          }
          any = true;
        } else out.droppedIds++;
      }
      if (any) evidence.push(item);
    }
    if (!evidence.length) {
      out.droppedNoEvidence++;
      continue;
    }
    const confidence = Math.round(f.confidence * 100) / 100;
    out.drafts.push({
      ruleId: null,
      category: f.category,
      severity: f.severity,
      title: title.length > 140 ? `${title.slice(0, 139)}…` : title,
      whyItMatters: f.why_it_matters.trim(),
      detail: `${f.detail.trim()}\n\nModel confidence ${confidence.toFixed(2)}.`,
      evidence,
      key: [normalizeKey(title), ...[...new Set(ids)].sort()],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The pass and the job
// ---------------------------------------------------------------------------

export interface AiPassResult extends ApplyResult {
  runId: string;
  model: string;
  callId: string;
  ledgerSource: 'ask-context' | 'local';
  ledgerChars: number;
  returned: number;
  droppedNoEvidence: number;
  droppedWording: number;
  usage: Usage;
}

export interface AiPassDeps {
  /** Replaceable for tests: same signature as callStructured. */
  call?: typeof callStructured;
  ledger?: LedgerSection[];
  today?: string;
  setProgress?: (progress: number, text?: string) => void;
}

/** Most findings of each list named in the user message, newest first. */
const ON_FILE_LIMIT = 300;
/** Evidence tokens shown per finding: enough to recognise a restatement. */
const ON_FILE_TOKENS = 8;

/**
 * What the model is told not to raise again, with each finding's category
 * and evidence tokens so a reworded restatement is recognisable:
 * - onFile: findings of either origin still new or confirmed;
 * - judged: findings the patient dismissed, disputed or resolved. An
 *   automatic clearance ("Cleared automatically: …") is the engine's, not a
 *   verdict, so those stay out.
 */
export function findingsOnFile(limit = ON_FILE_LIMIT): { onFile: FindingOnFile[]; judged: FindingOnFile[] } {
  const d = db();
  const f = schema.findings;
  const pick = { id: f.id, category: f.category, title: f.title, origin: f.origin, status: f.status, verdictNote: f.verdictNote };
  const open = d.select(pick).from(f).where(and(isNull(f.deletedAt), inArray(f.status, ['new', 'confirmed']))).orderBy(desc(f.updatedAt)).limit(limit).all();
  const judged = d
    .select(pick)
    .from(f)
    .where(and(isNull(f.deletedAt), inArray(f.status, ['dismissed', 'disputed', 'resolved'])))
    .orderBy(desc(f.updatedAt))
    .all()
    .filter((r) => !(r.verdictNote ?? '').startsWith(AUTO_CLEARED_PREFIX))
    .slice(0, limit);
  const ids = [...open, ...judged].map((r) => r.id);
  const tokens = new Map<string, string[]>();
  if (ids.length) {
    const fe = schema.findingEvidence;
    const rows = d.select({ findingId: fe.findingId, factId: fe.factId, communicationId: fe.communicationId, documentId: fe.documentId }).from(fe).where(inArray(fe.findingId, ids)).orderBy(fe.findingId, fe.sortOrder).all();
    for (const e of rows) {
      const list = tokens.get(e.findingId) ?? [];
      for (const t of [e.factId ? `⟦F:${e.factId}⟧` : null, e.communicationId ? `⟦C:${e.communicationId}⟧` : null, e.documentId ? `⟦D:${e.documentId}⟧` : null]) {
        if (t && list.length < ON_FILE_TOKENS && !list.includes(t)) list.push(t);
      }
      tokens.set(e.findingId, list);
    }
  }
  const toLine = (r: (typeof open)[number]): FindingOnFile => ({ category: r.category, title: r.title, origin: r.origin, status: r.status, evidence: tokens.get(r.id) ?? [] });
  return { onFile: open.map(toLine), judged: judged.map(toLine) };
}

/**
 * The document ids recorded for the call. Without a document scope the
 * ledger draws on the whole case, so the AI log names every live document
 * rather than none.
 */
function documentIdsSent(scope: CrossrefScope): string[] {
  if (scope.documentIds?.length) return scope.documentIds;
  return db().select({ id: schema.documents.id }).from(schema.documents).where(isNull(schema.documents.deletedAt)).all().map((r) => r.id);
}

/** The job's closing progress line: what was written and every reason something was dropped. */
export function passSummary(applied: Pick<ApplyResult, 'created' | 'updated'>, stats: AiRunStats): string {
  const parts = [`${applied.created} new`, `${applied.updated} updated`, `${stats.droppedNoEvidence} dropped for missing evidence`];
  if (stats.droppedWording) parts.push(`${stats.droppedWording} dropped for diagnostic wording`);
  return parts.join(', ');
}

export async function runAiPass(opts: { runId: string; jobId?: string | null; signal?: AbortSignal }, deps: AiPassDeps = {}): Promise<AiPassResult> {
  const run = getRunRow(opts.runId);
  if (!run) throw new Error('crossref run not found');
  const call = deps.call ?? callStructured;
  const progress = deps.setProgress ?? (() => undefined);
  const scope = runScope(run);
  progress(0.05, 'building the ledger');
  let ledgerSource: 'ask-context' | 'local' = 'local';
  let ledger = deps.ledger;
  if (!ledger) {
    const loaded = await loadLedger({ documentIds: scope.documentIds, from: scope.from, to: scope.to });
    ledger = loaded.sections;
    ledgerSource = loaded.source;
  }
  const ledgerChars = ledger.reduce((n, s) => n + s.text.length, 0);
  const user = buildCrossrefUserMessage({ today: deps.today ?? todayIso(), ledger, ...findingsOnFile() });
  progress(0.15, `calling the model (${Math.round(ledgerChars / 3.6 / 1000)}k tokens of ledger)`);
  try {
    const res = await call({
      purpose: 'crossref',
      model: run.model ?? undefined,
      deep: run.deep,
      system: CROSSREF_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
      schema: crossrefOutput,
      timeoutMs: 60 * 60 * 1000,
      jobId: opts.jobId ?? null,
      signal: opts.signal,
      documentIds: documentIdsSent(scope),
      // Its own effort (default high), never the global ai.effort: at max a
      // Fable pass spent all 32k output tokens on hidden reasoning and
      // returned no JSON. Reasoning counts against max_tokens, so the budget
      // is 64k as well.
      effort: getSetting('ai.crossref.effort'),
      maxTokens: 64000,
      requestSummary: `cross-reference pass (${run.deep ? 'deep' : 'standard'}, ${ledger.length} sections)`,
    });
    progress(0.85, 'checking evidence');
    const mapped = mapAiOutput(res.data, loadAiLookups());
    const applied = applyDrafts(run.id, 'ai', mapped.drafts);
    const aiStats: AiRunStats = {
      returned: mapped.returned,
      kept: applied.created + applied.updated + applied.unchanged,
      droppedNoEvidence: mapped.droppedNoEvidence + applied.invalid,
      droppedWording: mapped.droppedWording,
      droppedIds: mapped.droppedIds + applied.droppedIds,
    };
    finishRun(run.id, { status: 'done', aiCallIds: [res.callId], aiStats });
    progress(1, passSummary(applied, aiStats));
    return { ...applied, droppedIds: aiStats.droppedIds, runId: run.id, model: res.model, callId: res.callId, ledgerSource, ledgerChars, returned: mapped.returned, droppedNoEvidence: aiStats.droppedNoEvidence, droppedWording: aiStats.droppedWording, usage: res.usage };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishRun(run.id, { status: 'failed', error: message });
    if (err instanceof AiDisabledError || err instanceof NoApiKeyError || err instanceof AiRefusedError) throw err;
    throw err instanceof Error ? err : new Error(message);
  }
}

export async function crossrefJob(ctx: JobContext<{ runId: string }>): Promise<AiPassResult> {
  const { runId } = ctx.payload;
  if (!runId) throw new Error('crossref: runId missing');
  return runAiPass({ runId, jobId: ctx.job.id, signal: ctx.signal }, { setProgress: ctx.setProgress });
}
