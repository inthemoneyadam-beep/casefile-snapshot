/**
 * The lab check (2026-10-08): after every reading, the app reads each page's lab result rows itself (no AI) and checks
 * that a detail holds each one. Rows no detail holds are read again once with a hint; a row still missed is added from
 * the page by the app. The report lives in `documents.metadata_json.coverage.labCheck` (one writer:
 * src/server/services/lab-check.ts); the document page and the clinician read it with `labCheckWords`.
 * Pure: no database, no Node APIs (also used by the browser).
 */
import { z } from 'zod';

/**
 * Bump when the check (the row finder or the matching) changes so that every read document is checked again at unlock.
 * 2 (2026-10-09, lab recall): a document with many lines missed is no longer left alone (its pages are read again in
 * small calls under the limit, else Claude asks once); documents the old guard left alone get it at the next unlock.
 */
export const LAB_CHECK_VERSION = 2;

/** `facts.origin` of a lab value the app read off the page itself (the lab check, or the clinician at the user's request). */
export const LAB_CHECK_ORIGIN = 'parsed';

/** The private attribute a value added from the page carries (`facts.attributes_json._labCheck`). */
export const LAB_CHECK_ATTRIBUTE = '_labCheck';

const pageNo = z.number().int().min(1);

/** One lab row as printed on a page. */
export const labCheckRowRef = z.object({
  page: pageNo,
  /** The row as printed: its cells joined by " | ". */
  text: z.string().max(400),
  analyte: z.string().max(200),
  value: z.string().max(100),
  unit: z.string().max(60).nullable(),
  range: z.string().max(160).nullable(),
  flag: z.string().max(40).nullable(),
});
export type LabCheckRowRef = z.infer<typeof labCheckRowRef>;

export const labCheckAdded = labCheckRowRef.extend({
  factId: z.string(),
  by: z.enum(['lab_check', 'clinician']),
  at: z.string(),
  /** new: a detail was made; existing: the row was cited on a detail that already held the same value (no copy). */
  cited: z.enum(['new', 'existing']),
  /** Taken back with Undo (2026-10-09): listed as such, no longer counted as added, nothing links to it. */
  undone: z.boolean().optional(),
});
export type LabCheckAdded = z.infer<typeof labCheckAdded>;

export const LAB_CHECK_TRIGGERS = ['pass', 'unlock', 'reread', 'add', 'manual'] as const;
export type LabCheckTrigger = (typeof LAB_CHECK_TRIGGERS)[number];

export const labCheckReport = z.object({
  v: z.literal(1),
  /** LAB_CHECK_VERSION of the check that wrote it. */
  version: z.number().int(),
  at: z.string(),
  trigger: z.enum(LAB_CHECK_TRIGGERS),
  /** Pages the model has read (coverage `done`) that were looked at. */
  pagesChecked: z.number().int().min(0),
  pagesWithRows: z.number().int().min(0),
  rowsFound: z.number().int().min(0),
  /** Rows a detail holds (ones added from the page included). */
  matched: z.number().int().min(0),
  /** Rows no detail holds now. */
  missed: z.number().int().min(0),
  /** The rows missed now (first 200). */
  missedRows: z.array(labCheckRowRef),
  /** What the check found missing before anything was done about it (the re-read, the additions). */
  firstMissed: z.object({ count: z.number().int().min(0), pages: z.array(pageNo), at: z.string() }).nullable(),
  /** The automatic re-read of the pages with misses (once). */
  reread: z
    .object({
      at: z.string(),
      pages: z.array(pageNo),
      rows: z.number().int().min(0),
      /** ask (2026-10-09): above the limit, waiting for the user's yes (coverage.resume, kind labcheck). */
      status: z.enum(['queued', 'done', 'skipped', 'failed', 'ask']),
      jobId: z.string().nullable(),
      reason: z.string().nullable(),
      /** What reading those pages again costs (about), in how many small calls. */
      estimateUsd: z.number().min(0).optional(),
      calls: z.number().int().min(0).optional(),
    })
    .nullable(),
  /** Rows the re-read was asked to bring in (keys: page, test, value), so a row is read again only once. */
  rereadKeys: z.array(z.string()),
  /** Values added from the page (first 200) and how many in all. */
  added: z.array(labCheckAdded),
  addedCount: z.number().int().min(0),
  /** Rows left alone because the user deleted the detail that held them. */
  deletedByYou: z.number().int().min(0),
  notes: z.array(z.string()),
  /** Every page with a line missed now (missedRows lists the first 200 lines only). */
  missedPages: z.array(pageNo).max(2000).optional(),
  /**
   * Pages whose missed lines are NOT added from the page by themselves (2026-10-09): what the app read there fails a
   * sanity test (most lines not found word for word on the page, or the page looks like a reference or trend table).
   */
  heldBack: z.array(z.object({ page: pageNo, rows: z.number().int().min(0), reason: z.string().max(300) })).max(500).optional(),
});
export type LabCheckReport = z.infer<typeof labCheckReport>;

/** A stored report read without ever throwing (null when missing or not this shape). */
export function parseLabCheckReport(raw: unknown): LabCheckReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = labCheckReport.safeParse(raw);
  return r.success ? r.data : null;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** "p.88", "pp.12, 40, 88", "pp.12, 40 and 12 more". */
export function pagesWords(pages: readonly number[], max = 8): string {
  const list = [...new Set(pages)].sort((a, b) => a - b);
  if (!list.length) return '';
  if (list.length === 1) return `p.${list[0]}`;
  const shown = list.slice(0, max).join(', ');
  return `pp.${shown}${list.length > max ? ` and ${list.length - max} more` : ''}`;
}

export interface LabCheckWords {
  /** One sentence for the "How much was read" panel and the clinician. */
  line: string;
  /** Pages to link (the ones the check found missing, else the ones still missing). */
  pages: number[];
  /** Pages with rows still missing now ("Read these pages again"). */
  stillMissing: number[];
}

/**
 * The check in plain words:
 * - "Lab check: 380 lab lines found; all pulled out."
 * - "Lab check: 380 lab lines found; 3 missed on pp.12, 40, 88: read again; 1 added from the page."
 * - "...: being read again." while the re-read waits or runs; "; 2 still missing on pp.12, 40." when some remain.
 */
export function labCheckWords(r: LabCheckReport | null | undefined): LabCheckWords | null {
  if (!r) return null;
  const stillMissing = [...new Set(r.missedPages?.length ? r.missedPages : r.missedRows.map((m) => m.page))].sort((a, b) => a - b);
  if (r.rowsFound === 0) return { line: 'Lab check: no lab lines found on the pages read.', pages: [], stillMissing };
  const found = `Lab check: ${plural(r.rowsFound, 'lab line', 'lab lines')} found`;
  const first = r.firstMissed && r.firstMissed.count > 0 ? r.firstMissed : null;
  if (!first && r.missed === 0) return { line: `${found}; all pulled out.`, pages: [], stillMissing };
  const bits: string[] = [];
  if (first) {
    let s = `${first.count} missed on ${pagesWords(first.pages)}`;
    if (r.reread?.status === 'done') s += ': read again';
    else if (r.reread?.status === 'queued') s += ': being read again';
    else if (r.reread?.status === 'ask') s += `: reading them again waits for your go-ahead${r.reread.estimateUsd != null ? ` (about $${r.reread.estimateUsd.toFixed(2)})` : ''}`;
    bits.push(s);
  }
  if (r.addedCount > 0) bits.push(`${r.addedCount} added from the page`);
  // While the pages are being read again (or wait for a yes), the lines found missing are the ones named above.
  const waiting = r.reread?.status === 'queued' || r.reread?.status === 'ask';
  if (r.missed > 0 && !(waiting && first)) bits.push(`${r.missed} ${first ? 'still missing' : 'missing'} on ${pagesWords(stillMissing)}`);
  const held = r.heldBack ?? [];
  if (held.length && r.missed > 0) {
    const n = held.reduce((k, h) => k + h.rows, 0);
    bits.push(`${n} not added by themselves on ${pagesWords(held.map((h) => h.page))} (see why)`);
  }
  return { line: `${found}; ${bits.join('; ')}.`, pages: first ? [...new Set(first.pages)].sort((a, b) => a - b) : stillMissing, stillMissing };
}

/** What a lab value added from the page carries in `_labCheck`. */
export interface LabCheckMark {
  by: 'lab_check' | 'clinician';
  page: number;
  row: string;
  at: string;
  filingId?: string | null;
  askMessageId?: string | null;
}

/** The `_labCheck` mark of a fact's attributes (stored text or parsed), when the app added it from the page. */
export function labCheckMarkOf(attributes: string | Record<string, unknown> | null | undefined): LabCheckMark | null {
  let a: unknown = attributes;
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a);
    } catch {
      return null;
    }
  }
  if (!a || typeof a !== 'object') return null;
  const m = (a as Record<string, unknown>)[LAB_CHECK_ATTRIBUTE];
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if ((o.by !== 'lab_check' && o.by !== 'clinician') || typeof o.page !== 'number') return null;
  return {
    by: o.by,
    page: o.page,
    row: typeof o.row === 'string' ? o.row : '',
    at: typeof o.at === 'string' ? o.at : '',
    filingId: typeof o.filingId === 'string' ? o.filingId : null,
    askMessageId: typeof o.askMessageId === 'string' ? o.askMessageId : null,
  };
}

/** "Added by the lab check from p.88." / "Added by the clinician at your request, from p.88." (null otherwise). */
export function labAddedNote(attributes: string | Record<string, unknown> | null | undefined): string | null {
  const m = labCheckMarkOf(attributes);
  if (!m) return null;
  return m.by === 'clinician' ? `Added by the clinician at your request, from p.${m.page}.` : `Added by the lab check from p.${m.page}.`;
}
