/**
 * Prompt and output schema for the cross-reference AI pass. The system
 * prompt is static so the API caches it; the ledger, the date, the findings
 * already on file and the findings the patient has already judged go in the
 * user message.
 */
import { z } from 'zod';
import { CROSSREF_FINDING_CATEGORIES, FINDING_SEVERITIES } from '../../../shared/enums';

export const CROSSREF_SYSTEM_PROMPT = `You cross-reference one patient's complete case ledger on behalf of the patient and their advocate. The ledger lists facts extracted from medical records with their status, the communications log, the records held and missing, medications, labs, imaging, encounters and open tasks. Every fact line ends with a token ⟦F:<id>⟧, every communication line with ⟦C:<id>⟧, and document mentions carry ⟦D:<id> p.<n>⟧. The ids inside those tokens are the only valid evidence ids.

Your job is to find what the records reveal only when read together, in five categories:
- discrepancy: two sources disagree about a date, a dose, a result, an effect, a label, or who said what.
- missing_record: a record is referred to but not held, or a result is mentioned without its report.
- trend: a value or a symptom moving in one direction across several records, or something never seen in range.
- overlooked: a recommendation, referral, follow-up, question or abnormal result that nothing later picks up.
- correlation: a symptom change, reaction or event close in time to a start, stop, dose change or procedure. Begin the title with "Correlation only:".

Rules
- Evidence is mandatory. Every finding lists at least one evidence item with a fact_id, a communication_id, or a document_id (with the page and a short verbatim quote when the ledger shows the passage). Copy ids exactly as they appear inside the tokens. A finding without usable evidence is discarded.
- Never diagnose, never recommend a treatment, never predict an outcome. Describe what the records say and why the gap or pattern deserves a human look. Write "the records disagree", "no later record shows", "worth raising with the team"; never "the patient has", "this confirms", "likely diagnosis", "should be treated with".
- Respect fact status: [disputed] facts were rejected by the patient and are not evidence; when you rely on an [unverified] fact, say so in the detail.
- Do not restate any finding listed in the user message, even in other words or with extra evidence: the findings already on file are recorded, and the findings the patient already judged (dismissed, disputed or resolved) must not be raised again. Add what the deterministic rules cannot see: wording that contradicts across documents, numbers that do not add up, a plan that quietly changed, a question nobody answered, timing worth noticing.
- Prefer fewer, well-evidenced findings over many weak ones. One finding per issue. Dates at the precision given.
- title: one line under 120 characters. why_it_matters: two or three plain sentences for the patient. detail: the specifics with dates, values and sources. severity: info, low, medium or high. confidence: how sure you are that the records support the finding, 0 to 1.

Return only the structured output.`;

export const crossrefEvidence = z.object({
  fact_id: z.string().nullable().describe('The id inside a ⟦F:…⟧ token, or null'),
  communication_id: z.string().nullable().describe('The id inside a ⟦C:…⟧ token, or null'),
  document_id: z.string().nullable().describe('The id inside a ⟦D:…⟧ token, or null'),
  page: z.number().int().nullable().describe('Page number for a document passage, or null'),
  quote: z.string().nullable().describe('Short verbatim passage from that page, or null'),
  note: z.string().describe('What this item shows, in a few words'),
});

export const crossrefFinding = z.object({
  // The five kinds of the cross-reference pass only (a document checked against itself has its own: services/self-check.ts).
  category: z.enum(CROSSREF_FINDING_CATEGORIES),
  title: z.string(),
  why_it_matters: z.string(),
  detail: z.string(),
  severity: z.enum(FINDING_SEVERITIES),
  evidence: z.array(crossrefEvidence).min(1).max(12),
  confidence: z.number().min(0).max(1),
});

export const crossrefOutput = z.object({ findings: z.array(crossrefFinding) });
export type CrossrefOutput = z.infer<typeof crossrefOutput>;
export type CrossrefAiFinding = z.infer<typeof crossrefFinding>;

export interface LedgerSection {
  key: string;
  title: string;
  text: string;
  factIds?: string[];
}

/** A finding named in the user message so the model does not raise it again. */
export interface FindingOnFile {
  category: string;
  title: string;
  /** 'rule' or 'ai'. */
  origin: string;
  status: string;
  /** Evidence tokens as the ledger prints them: ⟦F:id⟧, ⟦C:id⟧, ⟦D:id⟧. */
  evidence: string[];
}

export interface CrossrefUserMessageInput {
  today: string;
  ledger: LedgerSection[];
  /** Findings of either origin still new or confirmed: not to be repeated. */
  onFile: FindingOnFile[];
  /** Findings the patient dismissed, disputed or resolved (never the engine's automatic clearances): not to be raised again. */
  judged: FindingOnFile[];
}

function findingLine(f: FindingOnFile, withStatus: boolean): string {
  const tags = [f.category.replace(/_/g, ' '), f.origin === 'ai' ? 'AI pass' : 'rule', withStatus ? f.status : null].filter(Boolean).join(', ');
  return `- [${tags}] ${f.title}${f.evidence.length ? ` ${f.evidence.join(' ')}` : ''}`;
}

export function buildCrossrefUserMessage(input: CrossrefUserMessageInput): string {
  const head = [`Today is ${input.today}.`, ''];
  if (input.onFile.length) {
    head.push('Findings already on file (do not repeat these, even in other words):');
    for (const f of input.onFile) head.push(findingLine(f, false));
  } else {
    head.push('No findings are on file yet.');
  }
  if (input.judged.length) {
    head.push('', 'Findings the patient already judged (dismissed, disputed or resolved; do not raise these again, even in other words):');
    for (const f of input.judged) head.push(findingLine(f, true));
  }
  head.push('','Cross-reference the ledger below and return every finding the records support.', '', '=== LEDGER ===');
  const body = input.ledger.map((s) => `## ${s.title}\n${s.text.trimEnd() || '(nothing recorded)'}`).join('\n\n');
  return `${head.join('\n')}\n${body}\n`;
}
