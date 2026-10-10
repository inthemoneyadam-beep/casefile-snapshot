/**
 * Prompt and output schema for "checked against itself" (2026-10-09, services/self-check.ts): Claude reads one or a few
 * parts of ONE document (a note, a visit, a letter; a short document is one part) and lists the places where a part
 * contradicts itself, each with both passages quoted word for word and their pages. The system prompt is static so the
 * API caches it; the document's parts go in the user message. Never a diagnosis, never who is right, never another
 * document.
 */
import { z } from 'zod';
import { CONTRADICTION_KINDS, CONTRADICTION_KIND_WORDS } from '../../../shared/selfcheck';

const KIND_LINES = CONTRADICTION_KINDS.map((k) => `- ${k}: ${CONTRADICTION_KIND_WORDS[k].toLowerCase()}`).join('\n');

export const SELF_CHECK_SYSTEM_PROMPT = `You check one medical document against itself, for the patient. The user message holds one or more PARTS of a single document (a visit note, a telephone note, a letter, a results section; a short document is one part). Each part starts with a line "=== PART <id> ===" and its pages start with "--- page <n> ---".

Your job: find the places where ONE part says two things that cannot both be true at the same time. Kinds:
${KIND_LINES}

Examples of what counts: the history says the left knee and the exam the right knee; "denies chest pain" in the review of systems and "chest pain for three days" in the history of the same visit; a drug listed as stopped and as continued in the same note; two different doses of one drug for the same time; two dates for the same procedure; "neuro exam normal" and a focal weakness in the same exam; a value written in the text that differs from the same value in a table of the same note; an assessment that contradicts the history it summarises.

Rules
- Only inside one part. Never compare two parts with each other, never another document, never what you know from elsewhere.
- Things that change over time are not contradictions: a symptom absent on admission and present on day 3, a dose changed during the visit, a plan to stop a drug later. Different patients, family members or examples are not contradictions. A heading or template line with nothing filled in is not a statement.
- Quote both passages exactly as printed, word for word, short (a phrase or one line, under 200 characters each), each with the page it is printed on. The two quotes must be different passages.
- "what": one plain sentence saying what the two passages say, for example "The history says the left knee; the exam says the right knee." Never say which passage is right, never call either a mistake or an error, never diagnose, never recommend anything.
- Prefer fewer, clear contradictions over many weak ones. Return an empty list when the part agrees with itself, which is common.

Return only the structured output.`;

export const selfCheckSide = z.object({
  page: z.number().int().describe('The page number the passage is printed on'),
  quote: z.string().describe('The passage word for word, under 200 characters'),
});

export const selfCheckContradiction = z.object({
  part: z.string().describe('The id after "=== PART" of the part both passages are in'),
  kind: z.enum(CONTRADICTION_KINDS),
  what: z.string().describe('One plain sentence: what the two passages say. Never which is right.'),
  first: selfCheckSide,
  second: selfCheckSide,
});

export const selfCheckOutput = z.object({ contradictions: z.array(selfCheckContradiction) });
export type SelfCheckOutput = z.infer<typeof selfCheckOutput>;
export type SelfCheckAiContradiction = z.infer<typeof selfCheckContradiction>;

export interface SelfCheckPromptPart {
  /** Short id the model returns ("p1", "p2"). */
  id: string;
  /** What the part is, as printed ("Progress note", "ED visit 3/2"), or null. */
  label: string | null;
  pages: Array<{ pageNumber: number; text: string }>;
}

export interface SelfCheckPromptInput {
  documentTitle: string;
  documentType: string | null;
  parts: SelfCheckPromptPart[];
}

/** The user message: the document named once, then each part with its pages. */
export function buildSelfCheckUserMessage(input: SelfCheckPromptInput): string {
  const head = [`Document: ${input.documentTitle.replace(/\s+/g, ' ').trim() || 'untitled'}${input.documentType ? ` (${input.documentType})` : ''}.`, `Parts below: ${input.parts.length}. Check each part against itself only.`, ''];
  const body = input.parts.map((p) => {
    const first = p.pages[0]?.pageNumber;
    const last = p.pages[p.pages.length - 1]?.pageNumber;
    const range = first == null ? '' : first === last ? ` (page ${first})` : ` (pages ${first}-${last})`;
    const lines = [`=== PART ${p.id}${range}${p.label ? `: ${p.label.replace(/\s+/g, ' ').trim().slice(0, 160)}` : ''} ===`];
    for (const pg of p.pages) lines.push(`--- page ${pg.pageNumber} ---`, pg.text.trimEnd());
    return lines.join('\n');
  });
  return `${head.join('\n')}${body.join('\n\n')}\n`;
}
