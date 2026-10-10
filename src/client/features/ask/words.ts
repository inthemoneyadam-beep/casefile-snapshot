/**
 * Ask the clinician, in plain words: the kinds of answer, what the composer's
 * box and button say for each, the live status line while an answer is being
 * written (the server's notes name tools and token counts), each lookup the
 * clinician made, and the questions offered to start a conversation. The
 * server's own words stay on hover for support; none reach the screen as is.
 * Plain TypeScript (no React, no DOM) so tests can import it.
 */
import type { AskMode } from '@shared/ask';

/** Answer settings: how hard Claude thinks at a step of Depth, in words (the stored code is the key). */
export const EFFORT_WORDS: Record<'low' | 'medium' | 'high' | 'xhigh' | 'max', string> = { low: 'A little', medium: 'Some', high: 'Hard', xhigh: 'Very hard', max: 'As hard as it can' };
/** Answer settings: what of the case a step of Depth reads, in words. */
export const CONTEXT_WORDS: Record<'retrieval' | 'ledger' | 'everything', string> = {
  retrieval: 'The best-matching pages and details',
  ledger: 'The case summary and the best matches',
  everything: 'The case summary and as many pages as fit',
};

/** A step of Depth in one line, for its hover text: "Standard: thinks hard; reads the case summary and the best matches". */
export function depthStepWords(p: { label: string; effort: string; contextMode: string }): string {
  const thinks = EFFORT_WORDS[p.effort as keyof typeof EFFORT_WORDS];
  const reads = CONTEXT_WORDS[p.contextMode as keyof typeof CONTEXT_WORDS];
  return [p.label, [thinks ? `thinks ${thinks.toLowerCase()}` : null, reads ? `reads ${reads.charAt(0).toLowerCase()}${reads.slice(1)}` : null].filter(Boolean).join('; ')].filter(Boolean).join(': ');
}

/** "Kind of answer:" choices. (The shared ASK_MODE_LABELS says "Directory search"; the screen never does.) */
export const MODE_WORDS: Record<AskMode, string> = {
  question: 'Question',
  search: 'Find in the records',
  draft: 'Draft a message',
  briefing: 'Visit briefing',
};

/** Hover text for each kind of answer. */
export const MODE_TITLES: Record<AskMode, string> = {
  question: 'A plain answer to a question about the case, every statement citing its page',
  search: 'Where something is mentioned across the records: each place, with its page',
  draft: 'A message to someone on the care team, drafted from the records (nothing is sent)',
  briefing: 'What to bring up at a visit: the open questions, recent changes and results',
};

export function modeWords(mode: string | null | undefined): string {
  return mode && mode in MODE_WORDS ? MODE_WORDS[mode as AskMode] : 'Question';
}

/** The question box's hint for each kind of answer. */
export function modePlaceholder(mode: AskMode): string {
  switch (mode) {
    case 'search':
      return 'What to find, e.g. every mention of the MRI';
    case 'draft':
      return 'What the message should ask for, e.g. a copy of the March lab report';
    case 'briefing':
      return 'Anything to prepare for this visit (optional)';
    default:
      return 'Your question about the case, e.g. how has my CRP changed?';
  }
}

/** The send button's word for each kind of answer. */
export function sendWords(mode: AskMode): string {
  switch (mode) {
    case 'search':
      return 'Find';
    case 'draft':
      return 'Draft it';
    case 'briefing':
      return 'Brief me';
    default:
      return 'Ask';
  }
}

/** What the clinician looked up, by tool, in words. */
const TOOL_WORDS: Record<string, string> = {
  search_case: 'Searched the records',
  get_facts: 'Looked up details',
  get_lab_series: 'Looked up lab values',
  chart_lab_series: 'Charted lab values',
  get_document_pages: 'Read pages of a document',
  get_timeline: 'Looked at the timeline',
  get_communications: 'Looked up calls and messages',
  list_documents: 'Listed the documents',
  make_chart: 'Drew a chart',
  propose_refile: 'Suggested where to file a document',
  get_document_coverage: 'Checked how much of a document was read',
  get_document_outline: 'Looked at the visits in a document',
  get_thread: 'Read a conversation',
  propose_reprocess_many: 'Asked for documents to be read',
  propose_refile_many: 'Moved or suggested moving documents',
  add_lab_value_from_page: 'Added or suggested a lab value from a page',
  get_medication_timeline: "Looked at a drug's timeline",
  get_care_team: 'Looked at the care team',
  search_the_web: 'Searched the web',
  propose_care_candidate: 'Suggested someone for the care team',
};

/** The same, while it happens (the live status line). */
const TOOL_NOW: Record<string, string> = {
  search_case: 'Searching the records',
  get_facts: 'Looking up details',
  get_lab_series: 'Looking up lab values',
  chart_lab_series: 'Charting lab values',
  get_document_pages: 'Reading pages of a document',
  get_timeline: 'Looking at the timeline',
  get_communications: 'Looking up calls and messages',
  list_documents: 'Listing the documents',
  make_chart: 'Drawing a chart',
  propose_refile: 'Suggesting where to file a document',
  get_document_coverage: 'Checking how much of a document was read',
  get_document_outline: 'Looking at the visits in a document',
  get_thread: 'Reading a conversation',
  propose_reprocess_many: 'Asking for documents to be read',
  propose_refile_many: 'Moving documents',
  add_lab_value_from_page: 'Adding a lab value from a page',
  get_medication_timeline: "Looking at a drug's timeline",
  get_care_team: 'Looking at the care team',
  search_the_web: 'Searching the web',
  propose_care_candidate: 'Suggesting someone for the care team',
};

/** The quoted words in a tool summary (`search_case: "protein"` gives "protein"), if any. */
function quoted(summary: string): string | null {
  const m = /"([^"]{1,80})"/.exec(summary);
  return m ? m[1] : null;
}

/**
 * One lookup in plain words: "Searched the records for “protein”", "Looked up lab values: protein", "Drew a chart:
 * CSF protein". Ids, codes and tool names never show (the server's summary stays on hover).
 */
export function toolWords(name: string, summary: string): string {
  const base = TOOL_WORDS[name] ?? 'Looked something up';
  const rest = summary.startsWith(`${name}:`) ? summary.slice(name.length + 1).trim() : '';
  const q = quoted(summary);
  switch (name) {
    case 'search_case':
    case 'get_facts':
    case 'get_timeline':
    case 'get_communications':
    case 'list_documents':
      return q ? `${base} for “${q}”` : base;
    case 'get_lab_series':
    case 'chart_lab_series': {
      // "protein (csf) 2023…2025": the test's name as the clinician asked for it, without the codes and dates.
      const test = rest.replace(/\s*\([^)]*\)/g, '').replace(/\s+\S*…\S*$/, '').trim();
      return test ? `${base}: ${test}` : base;
    }
    case 'get_document_pages': {
      const pages = /p\.(\d+(?:-\d+)?)/.exec(rest);
      return pages ? `Read ${pages[1].includes('-') ? `pages ${pages[1].replace('-', ' to ')}` : `page ${pages[1]}`} of a document` : base;
    }
    case 'make_chart':
      return rest && rest !== 'untitled' ? `${base}: ${rest}` : base;
    case 'add_lab_value_from_page': {
      // "add_lab_value_from_page: 1a2b3c4d p.240 albumin index asked": the page, never the document's id.
      const page = /p\.(\d+)/.exec(rest);
      const asked = / asked$/.test(rest);
      return page ? `${asked ? 'Added a lab value from page' : 'Suggested adding a lab value from page'} ${page[1]}` : base;
    }
    default:
      return base;
  }
}

/**
 * The live status line while an answer is written, from the server's note ("assembling the case", "calling
 * get_facts", "reading 12 pages and a 31k-token ledger"). Unknown notes fall back to "Working".
 */
export function liveNoteWords(note: string | null | undefined): string {
  const n = (note ?? '').trim();
  if (!n || n === 'queued' || n === 'connecting') return 'Starting';
  if (n === 'assembling the case') return 'Gathering the case';
  if (/^counting tokens/.test(n)) return 'Measuring how much there is to read';
  const reading = /^reading (\d+) pages?(?: \((\d+) attached\))?/.exec(n);
  if (reading) {
    const pages = Number(reading[1]);
    const summary = /ledger/.test(n) ? ' and the case summary' : '';
    return pages ? `Reading ${pages} page${pages === 1 ? '' : 's'}${summary}` : `Reading the case summary`;
  }
  if (/^writing the answer/.test(n) || /writing the answer$/.test(n)) return 'Writing the answer';
  if (/^thinking/.test(n)) return 'Thinking';
  const retry = /^too long for the model; trying again with (\d+) pages/.exec(n);
  if (retry) return `Too much to read at once; trying again with ${retry[1]} pages`;
  const calling = /^calling (.+)$/.exec(n);
  if (calling) {
    const names = calling[1].split(',').map((s) => s.trim());
    return names.length === 1 ? (TOOL_NOW[names[0]] ?? 'Looking something up') : 'Looking things up';
  }
  if (/ done$/.test(n)) return 'Thinking';
  return 'Working';
}

/** Questions offered when there is no conversation yet: each fills the box (nothing is sent until you press Ask). */
export const STARTERS: ReadonlyArray<{ text: string; mode: AskMode; label: string }> = [
  { label: 'How has my CRP changed over time?', text: 'How has my CRP changed over time? Show it as a chart.', mode: 'question' },
  { label: 'List every procedure and its results', text: 'List every procedure with its date, where it was done and its result.', mode: 'question' },
  { label: 'Where do the records mention the MRI?', text: 'MRI', mode: 'search' },
  { label: 'Prepare me for my next specialist visit', text: 'Prepare me for my next specialist visit.', mode: 'briefing' },
];
