/**
 * Prompt for reading a plan document into a framework (the Plan page, 2026-10-09). The system prompt is static so the
 * API caches it; the pages (and, for a long plan, which part this is) go in the user message. The model only
 * transcribes the plan's structure in the plan's own words, each item with the passages that show it; it never adds
 * advice, never judges the plan and never fills in what the plan does not say.
 */
import { formatPageBlock, type ChunkPage } from './extraction';

export const PLAN_SYSTEM_PROMPT = `You read one plan document from a patient's personal case file (a care plan, a flare plan, a treatment or discharge plan, a plan the patient and his team wrote) and lay it out as a framework that a checklist and a timeline can be built from. You transcribe; you do not advise, judge, correct or complete the plan.

What to return
- title: the plan's own title, or a short plain name for it when it has none ("Flare plan", "Care plan after discharge").
- summary: one or two plain sentences: what the plan is for, who wrote it and for whom, as the pages say; null when they do not say.
- plan_date: the date the plan was written or issued, exactly as written, or null.
- items: every part of the plan, in the order it appears, as a flat list. Each item names its parent with parent_ref (the ref of the section, goal or decision it sits under; null at the top level). Give every item a ref unique in your answer ("1", "1.2", "1.2.3").

Kinds
- section: a heading or a block of the plan ("Acute flare", "Week 1", "Contacts").
- goal: an aim or target the plan states ("Keep the blood pressure under 130/80").
- step: something someone does ("Start the infusion", "Book the MRI").
- check: something to look at, measure or confirm ("Check temperature twice a day").
- criterion: a threshold, a sign or a rule the plan judges by ("Go to the ER if the chest pain returns").
- decision: a decision point ("If no better by day 3"); its branches are its children, each with its own condition ("if yes", "if no", "if fever above 38.5") and kind (usually step).
- contact: a person or place to call, with the number or address in detail when printed.
- medication: a drug named in the plan, with dose, route and timing in detail as written.
- other: anything else the plan states that belongs in its outline.

Fields
- title: the item in the plan's own words, shortened to one line when long. Never reword a dose, a number or a threshold.
- detail: more of the plan's own words about it (how, doses, why), or null.
- owner: who does it, exactly as written ("the patient", "neurology", "the chief of staff", "the infusion nurse"), or null when the plan does not say.
- timing: when, in the plan's own words ("within 1 hour", "day 3", "every Monday", "after the MRI"), or null.
- date: a calendar date the plan gives for it, as written, or null. Never work a date out from words such as "in two weeks".
- condition: the condition that starts it or the branch it belongs to, as written ("if fever above 38.5"), or null.
- actionable: true for what someone does or checks off (steps, checks, calls to make, medications to start or stop when the plan says to); false for headings, goals, background, contact lists and criteria that only describe.
- citations: 1 to 3 passages that show the item, each with the page number from the === PAGE n === marker it sits under and a verbatim quote of 5 to 300 characters copied exactly from that page (typos, numbers and units included).

Rules
- Use only what the pages say. Add nothing from medical knowledge, and never a step, a dose or a date the plan does not state.
- Keep the plan's order. Keep every number exactly as printed.
- When the pages are only part of the plan, read the part you are given; refs need only be unique in your answer.
- Return only the structured output. No commentary.`;

export interface PlanUserMessageInput {
  title: string;
  pages: ChunkPage[];
  totalPages: number;
  /** 1-based part of a plan read in several calls, and how many there are. */
  part: number;
  parts: number;
  documentDateText?: string | null;
}

/** The user turn: what the document is, which part this is, then the pages. */
export function buildPlanUserMessage(input: PlanUserMessageInput): string {
  const first = input.pages[0]?.pageNumber ?? 1;
  const last = input.pages[input.pages.length - 1]?.pageNumber ?? first;
  const header = [
    `Document title: ${input.title || '(untitled)'}`,
    input.documentDateText ? `Document date as recorded: ${input.documentDateText}` : null,
    input.parts > 1 ? `This is part ${input.part} of ${input.parts}: pages ${first}-${last} of ${input.totalPages}. Lay out only what these pages hold.` : `Pages ${first}-${last} of ${input.totalPages}: the whole plan.`,
    '',
  ].filter((l): l is string => l !== null);
  return `${header.join('\n')}\n${input.pages.map(formatPageBlock).join('\n')}`;
}
