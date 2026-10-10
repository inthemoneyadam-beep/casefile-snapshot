/**
 * Large exports and the messages inside them (2026-10-07, migration 0005): the shared contracts.
 *
 * - Segments (`document_segments`): a document cut into passages read, parsed or skipped on their own. `detail_json`
 *   is a SegmentDetail. A page is accounted for when every live segment touching it is settled (done, parsed, skipped
 *   or no_text); a document is `done` only when every page is (else `partial`).
 * - Coverage (`documents.metadata_json.coverage`): the compact summary of a document's segments (range-encoded), plus
 *   three sub-keys written by others: `legacy` (evidence captured before any repair), `resume` (the auto-resume
 *   decision) and `report` (the ingestion report). Writers merge their own keys and never replace the whole object.
 * - Upload (`documents.metadata_json.upload`): proof the whole file arrived and every page was stored; with coverage it
 *   gives the upload confirmation the "adding" banner follows.
 * - Messages: what the parsers read out of a record, `communications.details_json`, and the API views of a message
 *   and a thread. Keys (thread, message identity, body hash) are defined here once, so every package derives them the
 *   same way.
 * Pure: no database, no Node APIs (the browser imports the types and the wording helpers). Hashes are SHA-256 hex of
 * UTF-8 text, the same value node:crypto gives.
 */
import { z } from 'zod';
import {
  COMM_DIRECTIONS, COMM_MESSAGE_KINDS, COMM_ORIGINS, DOCUMENT_CATEGORIES, MESSAGE_VOICES, PAGE_COVERAGE_STATES,
  SEGMENT_KINDS, SEGMENT_ROUTES, SEGMENT_SKIP_REASONS, SEGMENT_STATUSES, SOURCE_TIERS,
  type PageCoverageState, type SegmentKind, type SegmentRoute, type SegmentSkipReason, type SegmentStatus,
} from '../enums';
import { EXTRACTION_SCHEMA_VERSION, LONG_TEXT_MAX } from '../constants';
import { parsePartialDate, type DatePrecision } from '../dates';
import { normalizeKey } from '../text';
import { labCheckReport } from '../labcheck';

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Bumped whenever segment boundaries, kinds, page hashing or the parsers change what they produce. */
export const SEGMENTER_VERSION = 1;
/**
 * The version a segment's result is from (`document_segments.schema_version`): a segment whose text_hash and version
 * equal those of its last settled pass is not read again unless forced.
 */
export function segmentResultVersion(extractionSchemaVersion: number = EXTRACTION_SCHEMA_VERSION, segmenterVersion: number = SEGMENTER_VERSION): number {
  return extractionSchemaVersion * 1000 + segmenterVersion;
}

const DATE_PRECISIONS = ['day', 'month', 'year', 'unknown'] as const satisfies readonly DatePrecision[];

// ---------------------------------------------------------------------------
// Hashing (pure SHA-256) and normalisation for keys
// ---------------------------------------------------------------------------

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of the UTF-8 bytes of `input`, as 64 lower-case hex characters (equal to node:crypto's). */
export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const len = bytes.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(len / 0x20000000));
  view.setUint32(total - 4, (len * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  let out = '';
  for (const x of h) out += x.toString(16).padStart(8, '0');
  return out;
}

/**
 * Text as compared for identity, never as shown or stored: compatibility forms folded, curly quotes and dashes made
 * plain, whitespace collapsed, lower case. The source text itself is never changed.
 */
export function normalizeForHash(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKC')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The hash of a message body for de-duplication and copy matching (the filed copy and the export's copy agree). */
export function bodyHashOf(body: string | null | undefined): string {
  return sha256Hex(normalizeForHash(body));
}

/**
 * A page's identity: its body text (running header, footer, banner and "(continued)" removed by the segmenter, then
 * normalised here) PLUS the digests of its images. Two pages with the same text and different scans differ. Only a page
 * with no image may be skipped as a duplicate of its twin (canSkipAsDuplicate).
 */
export function pageIdentityHash(body: string, imageDigests: readonly string[] = []): string {
  return sha256Hex(`t:${normalizeForHash(body)}\ni:${[...imageDigests].sort().join(',')}`);
}

/** A segment's text_hash: its pages' identity hashes, in page order. */
export function segmentHashOf(pageHashes: readonly string[]): string {
  return sha256Hex(`s:${pageHashes.join(',')}`);
}

/** Never skip a page that carries an image (a scan under a printed header is distinct content). */
export function canSkipAsDuplicate(page: { imageDigests?: readonly string[] | null; imageCoverage?: number | null }): boolean {
  return !(page.imageDigests && page.imageDigests.length) && !(page.imageCoverage && page.imageCoverage > 0);
}

const CREDENTIAL = '(?:MD|M\\.D\\.|DO|RN|BSN|MSN|LPN|MA|CMA|RMA|PA-C|PA|NP|FNP|APRN|DNP|PharmD|RPh|LMSW|LCSW|PT|DPT|OT|OTR\\/L|CNA|CRNA|PhD)';
const TRAILING_CREDENTIALS = new RegExp(`(?:\\s*,\\s*${CREDENTIAL}\\.?)+\\s*$`, 'i');

/**
 * A person's name as compared for keys: "Dr." and trailing credentials dropped (", MD", ", RN"), "Last, First Middle"
 * turned to "First Middle Last", then normalizeKey. "EXAMPLE,PAT Q" and "Pat Q Example" agree; "Pat Q. Example" and
 * "Pat Quinn Example" do not (alias matching is the people service's job, never a merge).
 */
/**
 * An author as printed with the credential the parser read from the same line: "Robin Example, RN" stays as it is (the
 * credential is printed already), "Robin Example" with role RN reads "Robin Example, RN" (2026-10-07 review, rev-comms
 * #12: "A. Example, MD, MD").
 */
export function authorWithRole(author: string, role: string | null | undefined): string {
  const a = author.trim();
  const r = (role ?? '').trim();
  if (!r) return a;
  const tail = a.toLowerCase().replace(/[.\s]+$/, '');
  const want = r.toLowerCase().replace(/[.\s]+$/, '');
  if (tail.endsWith(`, ${want}`) || tail.endsWith(` ${want}`) || tail === want) return a;
  return `${a}, ${r}`;
}

export function personNameKey(name: string | null | undefined): string {
  let s = (name ?? '').trim().replace(/^dr\.?\s+/i, '').replace(TRAILING_CREDENTIALS, '').trim();
  const comma = s.indexOf(',');
  if (comma > 0) s = `${s.slice(comma + 1)} ${s.slice(0, comma)}`;
  return normalizeKey(s);
}

/** A thread subject as compared: leading "RE:", "FW:", "Fwd:" dropped, then normalizeKey. */
export function subjectKey(subject: string | null | undefined): string {
  return normalizeKey((subject ?? '').replace(/^\s*(?:(?:re|fw|fwd)\s*:\s*)+/i, ''));
}

/** An encounter's key within its document: the page it starts on. */
export function encounterKeyOf(startPage: number): string {
  return `p${startPage}`;
}

/**
 * The thread a message belongs to (`communications.thread_key`). With a printed "Encounter #": that number and the
 * subject. Without one (most encounters in a long chart print): the document, the encounter's start page, its
 * type and department, and the subject. Opaque and free of record text (safe in a URL `?thread=`). When any message of
 * a parsed thread matches an existing communication by external key, the whole parsed thread takes that row's key.
 */
export function threadKeyOf(p: { documentId: string; subject: string; encounterNumber?: string | null; encounterStartPage?: number | null; encounterType?: string | null; department?: string | null }): string {
  const number = (p.encounterNumber ?? '').replace(/\D+/g, '');
  const basis = number
    ? `n|${number}|${subjectKey(p.subject)}`
    : `d|${p.documentId}|${p.encounterStartPage ?? ''}|${normalizeKey(p.encounterType)}|${normalizeKey(p.department)}|${subjectKey(p.subject)}`;
  return `t1_${sha256Hex(basis).slice(0, 32)}`;
}

/**
 * A message's identity across re-reads and across documents (`communications.external_key`): kind, author, day, time
 * and body hash. No document id, so the same message printed in two exports is one row. `ordinal` (1, 2, ...)
 * separates messages that would otherwise be identical in one document (two questionnaire receipts in the same minute),
 * counted in printed order.
 */
export function externalKeyOf(p: { kind: string; authorText: string | null | undefined; date: string | null | undefined; time: string | null | undefined; body: string | null | undefined }, ordinal = 1): string {
  const basis = `${p.kind}|${personNameKey(p.authorText)}|${p.date ?? ''}|${p.time ?? ''}|${bodyHashOf(p.body)}${ordinal > 1 ? `|#${ordinal}` : ''}`;
  return `m1_${sha256Hex(basis).slice(0, 32)}`;
}

/** A filed copy and a record's copy of one message may differ by up to this many minutes (composed 8:14, sent 8:15). */
export const COPY_TIME_TOLERANCE_MIN = 10;

// ---------------------------------------------------------------------------
// Printed dates and times
// ---------------------------------------------------------------------------

/** "8:15 AM", "8:15PM", "1613" (Epic's 24-hour HHMM), "16:13" -> "HH:MM" (24-hour); anything else -> null. */
export function toTime24(text: string | null | undefined): string | null {
  const t = (text ?? '').trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?$/i))) {
    let h = +m[1];
    const min = +m[2];
    if (h < 1 || h > 12 || min > 59) return null;
    const pm = m[3].toLowerCase() === 'p';
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
    return `${String(h).padStart(2, '0')}:${m[2]}`;
  }
  if ((m = t.match(/^(\d{2})(\d{2})$/)) || (m = t.match(/^(\d{1,2}):(\d{2})$/))) {
    const h = +m[1];
    const min = +m[2];
    if (h > 23 || min > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  return null;
}

/**
 * A printed stamp split into a partial date and a time: "7/15/2030 8:15 AM", "7/15/2030  8:15 AM", "07/14/30 2215",
 * "9/8/2030 1032", "8/2/2030 1:16 PM EDT". The text as printed is kept.
 */
export function parsePrintedDateTime(text: string | null | undefined): { date: string | null; precision: DatePrecision; time: string | null; text: string | null } {
  const raw = (text ?? '').trim();
  if (!raw) return { date: null, precision: 'unknown', time: null, text: null };
  const m = raw.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s+(\d{1,2}:\d{2}\s*[AaPp]\.?\s*[Mm]\.?|\d{4}|\d{1,2}:\d{2}))?(?:\s+[A-Z]{2,4})?$/);
  if (!m) {
    const p = parsePartialDate(raw);
    return { date: p.iso, precision: p.precision, time: null, text: raw };
  }
  const p = parsePartialDate(m[1]);
  return { date: p.iso, precision: p.precision, time: toTime24(m[2] ?? null), text: raw };
}

/** Minutes from a to b (both day-precision ISO dates with HH:MM times); null when either is incomplete. */
export function minutesBetween(a: { date: string | null | undefined; time: string | null | undefined }, b: { date: string | null | undefined; time: string | null | undefined }): number | null {
  const at = (x: { date: string | null | undefined; time: string | null | undefined }): number | null => {
    const d = (x.date ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const t = (x.time ?? '').match(/^(\d{2}):(\d{2})$/);
    if (!d || !t) return null;
    return Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]) / 60000;
  };
  const x = at(a);
  const y = at(b);
  return x === null || y === null ? null : y - x;
}

// ---------------------------------------------------------------------------
// Routing defaults
// ---------------------------------------------------------------------------

/** Settled statuses: the segment's pages are accounted for. */
export const SETTLED_SEGMENT_STATUSES: readonly SegmentStatus[] = ['done', 'parsed', 'skipped', 'no_text'];

export function isSettledSegmentStatus(status: string | null | undefined): boolean {
  return (SETTLED_SEGMENT_STATUSES as readonly string[]).includes(status ?? '');
}

/**
 * How each kind is read unless the segmenter says otherwise in `detail.route`. Messages, telephone notes, letters,
 * questionnaires and patient-entered data are parsed without AI into Calls & Messages AND read by the model for their
 * clinical content (a patient's quoted value becomes his claim; the act of messaging is never a fact). Only
 * `boilerplate` is skipped, always with a pointer to its twin.
 */
export const SEGMENT_ROUTE_BY_KIND: Readonly<Record<SegmentKind, SegmentRoute>> = {
  patient_summary: 'extract',
  facesheet: 'extract',
  visit_info: 'extract',
  note: 'extract',
  telephone: 'parse_and_extract',
  messages: 'parse_and_extract',
  letter: 'parse_and_extract',
  questionnaire: 'parse_and_extract',
  appointment_request: 'parse_and_extract',
  patient_entered: 'parse_and_extract',
  lab_results: 'extract',
  imaging: 'extract',
  orders: 'extract',
  medication_list: 'extract',
  mar: 'extract',
  flowsheets: 'extract',
  vitals: 'extract',
  procedures: 'extract',
  therapy_plan: 'extract',
  care_plan: 'extract',
  history: 'extract',
  instructions: 'extract',
  education: 'extract',
  media: 'extract',
  boilerplate: 'skip',
  pages: 'extract',
  other: 'extract',
};

/** The route of a segment: its own `detail.route`, else its kind's default. */
export function routeOf(seg: { kind: string; detail?: { route?: SegmentRoute | null } | null }): SegmentRoute {
  return seg.detail?.route ?? SEGMENT_ROUTE_BY_KIND[seg.kind as SegmentKind] ?? 'extract';
}

/** Why a model call for a segment failed (`detail.failure.kind`). */
export const SEGMENT_FAILURE_KINDS = ['refused', 'schema', 'network', 'rate_limit', 'overflow', 'ocr', 'cancelled', 'interrupted', 'other'] as const;
export type SegmentFailureKind = (typeof SEGMENT_FAILURE_KINDS)[number];

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

const pageNo = z.number().int().min(1);
const pageRange = z.tuple([pageNo, pageNo]);
export type PageRange = [number, number];

/** What the segmenter learned about one page (inside `detail.pages`). */
export const segmentPageInfo = z.object({
  page: pageNo,
  /** pageIdentityHash(body, imageDigests). */
  hash: z.string().optional(),
  imageDigests: z.array(z.string()).optional(),
  /** Largest share of the page an image block covers, 0-1. OCR runs at 0.1 or more, or under ~40 body characters. */
  imageCoverage: z.number().min(0).max(1).optional(),
  /** Characters left once the running header, footer and banner are removed. */
  bodyChars: z.number().int().min(0).optional(),
  /** OCR appended to this page (the text layer is kept). */
  ocr: z.object({ chars: z.number().int().min(0), confidence: z.number().nullable(), at: z.string(), error: z.string().nullable().optional() }).nullable().optional(),
  /** This page's own state when it differs from its segment's (a twin skipped inside a done segment, a blank page). */
  state: z.enum(PAGE_COVERAGE_STATES).optional(),
  skipReason: z.enum(SEGMENT_SKIP_REASONS).optional(),
  /** The page this one repeats (skipped duplicates and boilerplate). */
  twinPage: pageNo.optional(),
}).loose();
export type SegmentPageInfo = z.infer<typeof segmentPageInfo>;

/** `document_segments.detail_json`. Every field optional; unknown fields are kept. */
export const segmentDetail = z.object({
  /** The SEGMENTER_VERSION that wrote the segment (an older one is segmented again). */
  segmenter: z.number().int().optional(),
  route: z.enum(SEGMENT_ROUTES).optional(),
  routeReason: z.string().optional(),
  /** How the boundary was found. */
  source: z.enum(['outline', 'banner', 'section', 'item', 'page_block']).optional(),
  /** encounterKeyOf(start page) of the encounter it belongs to, and that encounter's pages. */
  encounterKey: z.string().optional(),
  encounterPages: pageRange.optional(),
  /** The section heading and item heading as printed. */
  section: z.string().nullable().optional(),
  item: z.string().nullable().optional(),
  /** Bookmark titles from the top level down. */
  outlinePath: z.array(z.string()).optional(),
  /** Visual line index where it starts on its first page and ends on its last (sections can start mid-page). */
  startLine: z.number().int().min(0).optional(),
  endLine: z.number().int().min(0).optional(),
  pages: z.array(segmentPageInfo).optional(),
  aiCallIds: z.array(z.string()).optional(),
  /** Copy-detection signature (duplicates.ts): words and a base64 MinHash. */
  signature: z.object({ v: z.number().int(), words: z.number().int(), minhash: z.string() }).optional(),
  /** A separately filed document this segment is a copy of. */
  copyOf: z.object({ documentId: z.string(), similarity: z.number(), at: z.string() }).optional(),
  /** What the parsers found (counts; the rows are communications). */
  parse: z.object({ at: z.string(), version: z.number().int(), messages: z.number().int(), notes: z.number().int(), letters: z.number().int(), questionnaires: z.number().int(), media: z.number().int() }).optional(),
  failure: z.object({ kind: z.enum(SEGMENT_FAILURE_KINDS), message: z.string(), at: z.string() }).optional(),
  estimate: z.object({ chars: z.number().int(), approxUsd: z.number() }).optional(),
}).loose();
export type SegmentDetail = z.infer<typeof segmentDetail>;

/** A stored detail_json read without ever throwing ({} when missing or unreadable). */
export function parseSegmentDetail(json: string | null | undefined): SegmentDetail {
  if (!json) return {};
  try {
    const r = segmentDetail.safeParse(JSON.parse(json));
    return r.success ? r.data : {};
  } catch {
    return {};
  }
}

/** What the segmenter produces for one segment (written by the segments service; `seq` is the order). */
export const segmentDraft = z.object({
  seq: z.number().int().min(0),
  pageStart: pageNo,
  pageEnd: pageNo,
  kind: z.enum(SEGMENT_KINDS),
  headerText: z.string().nullable().default(null),
  encounterDate: z.string().nullable().default(null),
  encounterDatePrecision: z.enum(DATE_PRECISIONS).default('unknown'),
  encounterDateText: z.string().nullable().default(null),
  encounterType: z.string().nullable().default(null),
  department: z.string().nullable().default(null),
  encounterNumber: z.string().nullable().default(null),
  sourceTier: z.enum(SOURCE_TIERS).nullable().default(null),
  textHash: z.string().nullable().default(null),
  status: z.enum(SEGMENT_STATUSES).default('pending'),
  skipReason: z.enum(SEGMENT_SKIP_REASONS).nullable().default(null),
  /** The seq of the segment this one duplicates (resolved to its id when written). */
  duplicateOfSeq: z.number().int().min(0).nullable().default(null),
  detail: segmentDetail.default({}),
}).refine((s) => s.pageEnd >= s.pageStart, { message: 'pageEnd must not be before pageStart', path: ['pageEnd'] });
export type SegmentDraft = z.infer<typeof segmentDraft>;
export type SegmentDraftInput = z.input<typeof segmentDraft>;

/** A segment as the API returns it. */
export const segmentView = z.object({
  id: z.string(),
  documentId: z.string(),
  seq: z.number().int(),
  pageStart: z.number().int(),
  pageEnd: z.number().int(),
  kind: z.string(),
  route: z.enum(SEGMENT_ROUTES),
  headerText: z.string().nullable(),
  encounterDate: z.string().nullable(),
  encounterDatePrecision: z.string(),
  encounterDateText: z.string().nullable(),
  encounterType: z.string().nullable(),
  department: z.string().nullable(),
  encounterNumber: z.string().nullable(),
  sourceTier: z.string().nullable(),
  status: z.string(),
  skipReason: z.string().nullable(),
  attempts: z.number().int(),
  error: z.string().nullable(),
  factsCount: z.number().int(),
  messagesCount: z.number().int(),
  duplicateOfSegmentId: z.string().nullable(),
  encounterId: z.string().nullable(),
  recordId: z.string().nullable(),
  extractionRunId: z.string().nullable(),
  updatedAt: z.string(),
});
export type SegmentView = z.infer<typeof segmentView>;

/** One encounter (or the patient block) of a document's outline, with its segments. */
export const outlineEntry = z.object({
  encounterKey: z.string(),
  headerText: z.string().nullable(),
  date: z.string().nullable(),
  datePrecision: z.string(),
  dateText: z.string().nullable(),
  type: z.string().nullable(),
  department: z.string().nullable(),
  number: z.string().nullable(),
  pageStart: z.number().int(),
  pageEnd: z.number().int(),
  /** Worst-first: failed, running, pending; else the settled state of every page. */
  state: z.enum(PAGE_COVERAGE_STATES),
  factsCount: z.number().int(),
  messagesCount: z.number().int(),
  segments: z.array(segmentView),
});
export type OutlineEntry = z.infer<typeof outlineEntry>;

/** The `_segment` link stored in `facts.attributes_json` (internal key, never public). */
export const factSegmentRef = z.object({
  id: z.string(),
  seq: z.number().int(),
  kind: z.string(),
  /** The passage's tier when it differs from the document's (trust.ts). */
  tier: z.enum(SOURCE_TIERS).nullable().optional(),
  voice: z.enum(MESSAGE_VOICES).nullable().optional(),
  encounterKey: z.string().nullable().optional(),
});
export type FactSegmentRef = z.infer<typeof factSegmentRef>;

/**
 * "Same source" for the rules (D.1.8): the same document AND the same segment. A fact without a segment link (read
 * before segments existed, or typed) counts as the whole document, so two such facts behave exactly as before.
 */
export function sameSourceUnit(a: { documentId: string | null | undefined; segmentId?: string | null }, b: { documentId: string | null | undefined; segmentId?: string | null }): boolean {
  if ((a.documentId ?? null) !== (b.documentId ?? null)) return false;
  if (!a.segmentId || !b.segmentId) return true;
  return a.segmentId === b.segmentId;
}

// ---------------------------------------------------------------------------
// What the parsers read (no AI). Bodies are verbatim: joined across page breaks, running header and footer removed,
// nothing else changed. `spans` are verbatim quotes per page for citations (visual order; verified, never dropped).
// ---------------------------------------------------------------------------

export const citeSpan = z.object({ page: pageNo, quote: z.string().min(1).max(1000) });
export type CiteSpan = z.infer<typeof citeSpan>;

/** The encounter a parsed item sits in. */
export const encounterRef = z.object({
  /** encounterKeyOf(startPage). */
  key: z.string(),
  headerText: z.string().nullable(),
  date: z.string().nullable(),
  datePrecision: z.enum(DATE_PRECISIONS),
  dateText: z.string().nullable(),
  type: z.string().nullable(),
  department: z.string().nullable(),
  number: z.string().nullable(),
  startPage: pageNo,
  endPage: pageNo,
});
export type EncounterRef = z.infer<typeof encounterRef>;

export const readReceipt = z.object({
  /** As printed: "7/16/2030 2:47 PM". */
  atText: z.string(),
  date: z.string().nullable(),
  time: z.string().nullable(),
  /** The reader as printed. */
  byText: z.string(),
  byPersonId: z.string().nullable().optional(),
  page: pageNo,
});
export type ReadReceipt = z.infer<typeof readReceipt>;

/** One portal message (or MyChart appointment message, questionnaire receipt, patient-entered data). */
export const parsedMessage = z.object({
  kind: z.enum(COMM_MESSAGE_KINDS),
  subject: z.string(),
  fromText: z.string(),
  /** As printed; often a pool: "P <pool> (supporting <clinician>)". */
  toText: z.string(),
  /** "Sent" (the patient), "Sent and Delivered" (staff), "Sent by batch", as printed. */
  sentLabel: z.string(),
  sentText: z.string(),
  sentDate: z.string().nullable(),
  sentTime: z.string().nullable(),
  voice: z.enum(MESSAGE_VOICES),
  direction: z.enum(COMM_DIRECTIONS),
  /** Credential as printed after the author's name ("RN", "MD"). */
  authorRole: z.string().nullable(),
  /** The clinician a pool supports, as printed. */
  intendedFor: z.string().nullable(),
  readReceipt: readReceipt.nullable(),
  body: z.string(),
  pages: pageRange,
  headerPage: pageNo,
  /** 0 = printed first (newest) in its Messages block; stored chronologically, cited in printed order. */
  printedOrder: z.number().int().min(0),
  /** Which Messages block of the segment it was printed in. */
  blockIndex: z.number().int().min(0),
  encounter: encounterRef,
  segmentId: z.string().nullable(),
  /** "Appointment scheduled from MyChart": the request's fields as printed. */
  appointment: z.object({
    visitType: z.string().nullable(),
    whenText: z.string().nullable(),
    minutes: z.number().int().nullable(),
    provider: z.string().nullable(),
    department: z.string().nullable(),
    comments: z.string().nullable(),
  }).nullable(),
  spans: z.array(citeSpan),
  /** Read from a layout not yet seen in a real file (another system's "Patient Entered Data"): shown as unverified. */
  unverified: z.boolean(),
});
export type ParsedMessage = z.infer<typeof parsedMessage>;

/** One note: "Telephone Encounter by <name>[, CRED] at <M/D/YYYY> <HHMM>" and the other note types. */
export const parsedNote = z.object({
  noteType: z.string(),
  isTelephone: z.boolean(),
  authorText: z.string(),
  authorRole: z.string().nullable(),
  voice: z.enum(MESSAGE_VOICES),
  /** inbound / outbound / third_party when the note says; null when it cannot be told. */
  direction: z.enum(COMM_DIRECTIONS).nullable(),
  dateText: z.string(),
  date: z.string().nullable(),
  time: z.string().nullable(),
  body: z.string(),
  signedBy: z.string().nullable(),
  signedText: z.string().nullable(),
  sbar: z.boolean(),
  /** Phone numbers and other parties named in the body, as printed (seeds for the people directory: suggestions only). */
  phones: z.array(z.string()),
  thirdParties: z.array(z.string()),
  pages: pageRange,
  headerPage: pageNo,
  encounter: encounterRef,
  segmentId: z.string().nullable(),
  spans: z.array(citeSpan),
});
export type ParsedNote = z.infer<typeof parsedNote>;

/** One letter: "<title> by <author> on <date>", "Status: Sent | Sent by batch", "Letter body:". */
export const parsedLetter = z.object({
  title: z.string(),
  authorText: z.string().nullable(),
  dateText: z.string(),
  date: z.string().nullable(),
  status: z.string().nullable(),
  batch: z.boolean(),
  comments: z.string().nullable(),
  body: z.string(),
  pages: pageRange,
  encounter: encounterRef,
  segmentId: z.string().nullable(),
  spans: z.array(citeSpan),
});
export type ParsedLetter = z.infer<typeof parsedLetter>;

/** One questionnaire the patient filed ("Filed by Patient"); pairs with its "Questionnaire Submission" receipt. */
export const parsedQuestionnaire = z.object({
  name: z.string(),
  submittedText: z.string(),
  date: z.string().nullable(),
  time: z.string().nullable(),
  answers: z.array(z.object({ question: z.string(), answer: z.string() })),
  pages: pageRange,
  encounter: encounterRef,
  segmentId: z.string().nullable(),
  spans: z.array(citeSpan),
});
export type ParsedQuestionnaire = z.infer<typeof parsedQuestionnaire>;

/** One media item ("Patient Entered Attachment - Scan on <dt>", "After Hours Nurse Line - Scan on <dt>"). */
export const parsedMediaItem = z.object({
  kindText: z.string(),
  how: z.string().nullable(),
  atText: z.string(),
  date: z.string().nullable(),
  time: z.string().nullable(),
  description: z.string().nullable(),
  pages: pageRange,
  /** Pages carrying the item's image (OCR text, when any, is on those pages). */
  imagePages: z.array(pageNo),
  encounter: encounterRef,
  segmentId: z.string().nullable(),
});
export type ParsedMediaItem = z.infer<typeof parsedMediaItem>;

/** Everything the parsers read from one segment (or a whole document when segmentId is null). */
export const parsedSegmentContent = z.object({
  segmentId: z.string().nullable(),
  version: z.number().int(),
  messages: z.array(parsedMessage),
  notes: z.array(parsedNote),
  letters: z.array(parsedLetter),
  questionnaires: z.array(parsedQuestionnaire),
  media: z.array(parsedMediaItem),
});
export type ParsedSegmentContent = z.infer<typeof parsedSegmentContent>;

// ---------------------------------------------------------------------------
// Communications read out of records: `communications.details_json`, and the API views
// ---------------------------------------------------------------------------

/** Fields the user may edit on a communication. Once edited (listed in details.userFields), a re-read never writes them. */
export const USER_EDITABLE_COMM_FIELDS = [
  'occurredAt', 'occurredAtText', 'direction', 'channel', 'subject', 'summary', 'outcome', 'followUpPromised',
  'followUpDue', 'followUpOwnerPersonId', 'encounterId', 'participants', 'topics',
] as const;
export type UserEditableCommField = (typeof USER_EDITABLE_COMM_FIELDS)[number];

export const commCopyLink = z.object({
  /** filed_copy: a separately filed document holds this message; record_copy: another record prints it too. */
  kind: z.enum(['filed_copy', 'record_copy']),
  documentId: z.string(),
  pages: pageRange.nullable(),
  /** The other communication row, when the copy had one before linking (kept, never deleted). */
  communicationId: z.string().nullable().optional(),
  similarity: z.number().min(0).max(1),
  /** Minutes between the two stamps (filed 8:14, sent 8:15 = 1). */
  minutesApart: z.number().nullable(),
  linkedAt: z.string(),
});
export type CommCopyLink = z.infer<typeof commCopyLink>;

export const commMention = z.object({
  /** A call record that names this message ("messaged 9:05 am"), or a message that names a call. */
  kind: z.enum(['mentioned_by', 'mentions']),
  communicationId: z.string().nullable(),
  documentId: z.string().nullable(),
  page: pageNo.nullable(),
  /** The words that make the link, as printed ("9:05 am"). */
  text: z.string().nullable(),
  /** Suggested links wait for the user; confirmed ones were accepted. */
  status: z.enum(['suggested', 'confirmed', 'declined']),
});
export type CommMention = z.infer<typeof commMention>;

/** A model's summary of a message or thread: labelled "Model summary", regenerated, never written into `summary`. */
export const modelSummary = z.object({ text: z.string(), runId: z.string().nullable(), model: z.string().nullable().optional(), at: z.string() });
export type ModelSummary = z.infer<typeof modelSummary>;

/** `communications.details_json`. Every field optional ('{}' on rows made before 0005); unknown fields are kept. */
export const communicationDetails = z.object({
  kind: z.enum(COMM_MESSAGE_KINDS).optional(),
  origin: z.enum(COMM_ORIGINS).optional(),
  voice: z.enum(MESSAGE_VOICES).optional(),
  /** messageTier(document tier, voice): `patient` for the patient's own bodies even inside a clinical record. */
  tier: z.enum(SOURCE_TIERS).optional(),
  sentLabel: z.string().nullable().optional(),
  sentText: z.string().nullable().optional(),
  authorText: z.string().nullable().optional(),
  authorRole: z.string().nullable().optional(),
  recipientText: z.string().nullable().optional(),
  intendedFor: z.string().nullable().optional(),
  encounterHeader: z.string().nullable().optional(),
  encounterNumber: z.string().nullable().optional(),
  encounterKey: z.string().nullable().optional(),
  segmentId: z.string().nullable().optional(),
  pages: pageRange.optional(),
  headerPage: pageNo.optional(),
  printedOrder: z.number().int().min(0).optional(),
  bodyHash: z.string().optional(),
  readReceipts: z.array(readReceipt).optional(),
  modelSummary: modelSummary.nullable().optional(),
  userFields: z.array(z.string()).optional(),
  copies: z.array(commCopyLink).optional(),
  mentions: z.array(commMention).optional(),
  attachments: z.array(z.object({ documentId: z.string(), page: pageNo, atText: z.string().nullable(), kindText: z.string().nullable() })).optional(),
  unverified: z.boolean().optional(),
  /** The parser version that wrote it. */
  parseVersion: z.number().int().optional(),
}).loose();
export type CommunicationDetails = z.infer<typeof communicationDetails>;

/** A stored details_json read without ever throwing ({} when missing or unreadable). */
export function parseCommunicationDetails(json: string | null | undefined): CommunicationDetails {
  if (!json) return {};
  try {
    const r = communicationDetails.safeParse(JSON.parse(json));
    return r.success ? r.data : {};
  } catch {
    return {};
  }
}

/** True when the user has edited `field` on this communication (a re-read must leave it alone). */
export function userEdited(details: CommunicationDetails, field: UserEditableCommField): boolean {
  return Boolean(details.userFields?.includes(field));
}

const citationView = z.object({
  id: z.string(),
  documentId: z.string(),
  pageNumber: z.number().int(),
  quote: z.string(),
  verified: z.boolean(),
  matchKind: z.string().nullable(),
});

/** GET /api/communications/:id when the row was read from a record (also fine for any row): the message detail. */
export const messageView = z.object({
  id: z.string(),
  threadKey: z.string().nullable(),
  subject: z.string(),
  occurredAt: z.string().nullable(),
  occurredAtPrecision: z.string(),
  occurredAtText: z.string().nullable(),
  occurredTime: z.string().nullable(),
  direction: z.string(),
  channel: z.string(),
  /** Verbatim, as written; null on rows logged by hand. */
  body: z.string().nullable(),
  summary: z.string().nullable(),
  outcome: z.string().nullable(),
  documentId: z.string().nullable(),
  documentTitle: z.string().nullable(),
  details: communicationDetails,
  participants: z.array(z.object({ personId: z.string(), name: z.string(), kind: z.string(), role: z.string() })),
  citations: z.array(citationView),
  copies: z.array(commCopyLink.extend({ documentTitle: z.string().nullable() })),
  thread: z.object({ key: z.string(), position: z.number().int().min(1), count: z.number().int().min(1) }).nullable(),
});
export type MessageView = z.infer<typeof messageView>;

/** One line of a thread. */
export const threadMessageItem = z.object({
  id: z.string(),
  occurredAt: z.string().nullable(),
  occurredAtText: z.string().nullable(),
  occurredTime: z.string().nullable(),
  direction: z.string(),
  voice: z.enum(MESSAGE_VOICES).nullable(),
  authorText: z.string().nullable(),
  recipientText: z.string().nullable(),
  /** The first words of the body (or the summary on a hand-logged row). */
  snippet: z.string(),
  pages: pageRange.nullable(),
  documentId: z.string().nullable(),
  readAtText: z.string().nullable(),
  copies: z.number().int().min(0),
});
export type ThreadMessageItem = z.infer<typeof threadMessageItem>;

/** GET /api/communications/threads/:key: one thread, messages oldest first. */
export const threadView = z.object({
  key: z.string(),
  subject: z.string(),
  documentIds: z.array(z.string()),
  firstAt: z.string().nullable(),
  lastAt: z.string().nullable(),
  count: z.number().int().min(0),
  openFollowUps: z.number().int().min(0),
  /** The user's outcome when written, else the outcome worked out from the replies (with its source). */
  outcome: z.string().nullable(),
  outcomeSource: z.enum(['user', 'replies', 'none']),
  modelSummary: modelSummary.nullable(),
  messages: z.array(threadMessageItem),
});
export type ThreadView = z.infer<typeof threadView>;

/** GET /api/communications/threads: the list. */
export const threadListItem = threadView.omit({ messages: true, modelSummary: true }).extend({
  lastSnippet: z.string(),
  fromRecords: z.boolean(),
});
export type ThreadListItem = z.infer<typeof threadListItem>;

// ---------------------------------------------------------------------------
// People: alias suggestions (computed on read, NEVER merged automatically) and the user's merge with Undo
// ---------------------------------------------------------------------------

const personRef = z.object({ personId: z.string(), name: z.string(), kind: z.string() });

/** GET /api/people/merge-suggestions: people who may be one person ("Robin Example" and a call record's "Robin"). */
export const mergeSuggestion = z.object({
  /** Stable for the same set of people, so a declined suggestion stays declined. */
  id: z.string(),
  keep: personRef,
  others: z.array(personRef).min(1),
  /** One plain sentence: "Same surname and first initial; both sign telephone notes at Example Clinic." */
  reason: z.string(),
  evidence: z.array(z.object({
    kind: z.enum(['alias', 'name_form', 'signature', 'message', 'call_record', 'order']),
    text: z.string(),
    documentId: z.string().nullable(),
    page: pageNo.nullable(),
  })),
  strength: z.enum(['strong', 'possible']),
});
export type MergeSuggestion = z.infer<typeof mergeSuggestion>;

/** POST /api/people/merge: the user merges people (recorded in filings; Undo puts every link back). */
export const mergePeopleInput = z.object({
  keepId: z.string().trim().min(1),
  mergeIds: z.array(z.string().trim().min(1)).min(1).max(20),
  suggestionId: z.string().optional(),
  reason: z.string().max(2000).optional(),
});
export type MergePeopleInput = z.infer<typeof mergePeopleInput>;

export const mergeResult = z.object({
  filingId: z.string(),
  keepId: z.string(),
  mergedIds: z.array(z.string()),
  /** Rows re-pointed per table ("communication_participants": 12, "facts": 3, ...), as Undo will put them back. */
  repointed: z.record(z.string(), z.number().int().min(0)),
  undone: z.boolean(),
});
export type MergeResult = z.infer<typeof mergeResult>;

// ---------------------------------------------------------------------------
// Coverage: `documents.metadata_json.coverage`
// ---------------------------------------------------------------------------

const skipCounts = z.object({ duplicate: z.number().int().min(0), boilerplate: z.number().int().min(0), blank: z.number().int().min(0), no_text: z.number().int().min(0) });
export type SkipCounts = z.infer<typeof skipCounts>;

/**
 * Evidence captured before an automatic repair touches anything (findings A.5), and served read-only by the
 * diagnostics endpoint. Arrays are capped by the writer in the stored snapshot (calls that were not ok: newest 100;
 * runs and jobs: newest 50); the full rows stay in their tables.
 */
export const extractionEvidence = z.object({
  v: z.literal(1),
  capturedAt: z.string(),
  reason: z.enum(['before_repair', 'diagnostics']),
  document: z.object({
    extractionStatus: z.string(),
    textStatus: z.string(),
    textError: z.string().nullable(),
    pageCount: z.number().int(),
    category: z.string(),
    sourceTier: z.string(),
    inboxStatus: z.string().nullable(),
    filedActions: z.array(z.string()).nullable(),
    classificationError: z.string().nullable(),
    importMeta: z.unknown().nullable(),
    ingest: z.unknown().nullable(),
  }),
  runs: z.array(z.object({
    id: z.string(), status: z.string(), model: z.string(), deep: z.boolean(), startedAt: z.string(), finishedAt: z.string().nullable(),
    chunks: z.number().int(), factsCount: z.number().int(), okCalls: z.number().int(), error: z.string().nullable(),
  })),
  jobs: z.array(z.object({
    id: z.string(), type: z.string(), status: z.string(), attempts: z.number().int(), maxAttempts: z.number().int(), progressText: z.string().nullable(),
    error: z.string().nullable(), createdAt: z.string(), startedAt: z.string().nullable(), finishedAt: z.string().nullable(),
  })),
  calls: z.object({
    ok: z.number().int(),
    /** Page ranges of the calls that came back ok (from request_summary "p.a-b"). */
    okRanges: z.array(pageRange),
    notOk: z.array(z.object({
      id: z.string(), at: z.string(), status: z.string(), stopReason: z.string().nullable(), durationMs: z.number().int(), outputTokens: z.number().int(),
      pages: z.string().nullable(), error: z.string().nullable(),
    })),
  }),
  facts: z.array(z.object({ runId: z.string().nullable(), live: z.boolean(), count: z.number().int(), firstPage: z.number().int().nullable(), lastPage: z.number().int().nullable() })),
  pages: z.object({ empty: z.number().int(), ocr: z.number().int(), thin: z.number().int() }),
  /** Pages cited by live facts, range-encoded. */
  citedRanges: z.array(pageRange),
  locks: z.array(z.object({ at: z.string(), summary: z.string().nullable() })).optional(),
});
export type ExtractionEvidence = z.infer<typeof extractionEvidence>;

/** The auto-resume decision (2026-10-07): carry on alone up to `ai.autoResumeCeilingUsd`, above it ask once. */
export const resumeDecision = z.object({
  at: z.string(),
  estimateUsd: z.number().min(0),
  ceilingUsd: z.number().min(0),
  /** auto: under the ceiling, started; ask: waiting for the user; approved / declined: his answer. */
  decision: z.enum(['auto', 'ask', 'approved', 'declined']),
  pagesLeft: z.number().int().min(0),
  segmentsLeft: z.number().int().min(0),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  /**
   * What the question is about (2026-10-09, lab recall): `rest` (absent on older rows) is reading the pages not read
   * yet; `labcheck` is reading again the pages where the lab check found lab lines no value holds (`pages`, `rows`
   * lines named, in `calls` small calls). One slot: the question about the rest goes first.
   */
  kind: z.enum(['rest', 'labcheck']).optional(),
  pages: z.array(z.tuple([z.number().int().min(1), z.number().int().min(1)])).max(2000).optional(),
  rows: z.number().int().min(0).optional(),
  calls: z.number().int().min(0).optional(),
});
export type ResumeDecision = z.infer<typeof resumeDecision>;

/** The extraction estimate for what is left (or for a whole re-read), from the actual segments. */
export const segmentEstimate = z.object({
  segments: z.number().int().min(0),
  calls: z.number().int().min(0),
  pages: z.number().int().min(0),
  characters: z.number().int().min(0),
  approxInputTokens: z.number().int().min(0),
  approxOutputTokens: z.number().int().min(0),
  model: z.string(),
  approxUsd: z.number().min(0),
});
export type SegmentEstimate = z.infer<typeof segmentEstimate>;

/**
 * What one ingestion pass did (written by the communications/people/rules side after a pass into
 * `metadata_json.coverage.report`; shown on the document page and by the assistant). Counts and ids; plain words in
 * `notes`.
 */
export const ingestionReport = z.object({
  v: z.literal(1),
  at: z.string(),
  runId: z.string().nullable(),
  pages: z.object({
    total: z.number().int().min(0),
    /** Settled: read, parsed, skipped with a reason or with nothing to read. */
    covered: z.number().int().min(0),
    ocr: z.number().int().min(0),
    skipped: z.array(z.object({ reason: z.enum(SEGMENT_SKIP_REASONS), count: z.number().int().min(0), ranges: z.array(pageRange) })),
    failed: z.array(z.object({ pages: pageRange, reason: z.string() })),
    pending: z.number().int().min(0),
  }),
  communications: z.object({
    created: z.number().int().min(0),
    updated: z.number().int().min(0),
    unchanged: z.number().int().min(0),
    byKind: z.record(z.string(), z.number().int().min(0)),
  }),
  threads: z.object({
    created: z.number().int().min(0),
    total: z.number().int().min(0),
    /** Threads joined with a separately filed copy (the filed "Message to Dr. ..." and the record's message). */
    mergedWithFiled: z.array(z.object({ threadKey: z.string(), communicationId: z.string(), filedDocumentId: z.string(), pages: pageRange.nullable() })),
  }),
  people: z.object({
    created: z.array(z.object({ personId: z.string(), name: z.string(), kind: z.string() })),
    /** Never merged: offered on the People page. */
    suggested: z.array(z.object({ name: z.string(), kind: z.string(), reason: z.string(), matchPersonId: z.string().nullable(), matchName: z.string().nullable() })),
  }),
  gaps: z.object({
    closed: z.array(z.object({ recordId: z.string(), title: z.string(), segmentId: z.string().nullable(), pages: pageRange.nullable() })),
    heldRowsCreated: z.number().int().min(0),
    open: z.number().int().min(0),
  }),
  trust: z.object({
    /** Facts and messages trusted below their document (a patient's words inside a clinical record). */
    passagesBelowDocument: z.number().int().min(0),
    /** Of those, how many changed in this pass. */
    changed: z.number().int().min(0),
  }),
  medications: z.object({ filed: z.number().int().min(0), conflicts: z.number().int().min(0), reconciled: z.boolean() }),
  /**
   * The rules run after the reading: `new` and `cleared` count the findings whose evidence involves this document;
   * `caseNew` and `caseCleared` the whole run across the case (2026-10-07 review, rev-comms #13).
   */
  findings: z.object({
    new: z.number().int().min(0),
    cleared: z.number().int().min(0),
    runId: z.string().nullable(),
    caseNew: z.number().int().min(0).optional(),
    caseCleared: z.number().int().min(0).optional(),
  }),
  notes: z.array(z.string()),
});
export type IngestionReport = z.infer<typeof ingestionReport>;

/** An empty report to fill in. */
export function emptyIngestionReport(at: string, runId: string | null = null): IngestionReport {
  return {
    v: 1,
    at,
    runId,
    pages: { total: 0, covered: 0, ocr: 0, skipped: [], failed: [], pending: 0 },
    communications: { created: 0, updated: 0, unchanged: 0, byKind: {} },
    threads: { created: 0, total: 0, mergedWithFiled: [] },
    people: { created: [], suggested: [] },
    gaps: { closed: [], heldRowsCreated: 0, open: 0 },
    trust: { passagesBelowDocument: 0, changed: 0 },
    medications: { filed: 0, conflicts: 0, reconciled: false },
    findings: { new: 0, cleared: 0, runId: null },
    notes: [],
  };
}

/** Where a document's coverage stands. */
export const COVERAGE_STATES = ['complete', 'running', 'partial', 'unread'] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

/**
 * `documents.metadata_json.coverage`. The counted fields are computed (computeCoverage / computeLegacyCoverage) and
 * written by the segments service; `legacy`, `resume` and `report` belong to their writers and are carried over.
 */
export const documentCoverage = z.object({
  v: z.literal(1),
  at: z.string(),
  /** segments: from document_segments; legacy: worked out from citations and successful calls, before segments existed. */
  basis: z.enum(['segments', 'legacy']),
  state: z.enum(COVERAGE_STATES),
  pagesTotal: z.number().int().min(0),
  pagesWithText: z.number().int().min(0).nullable(),
  pagesOcr: z.number().int().min(0),
  /** Pages carrying an image block of 10% or more. */
  pagesImage: z.number().int().min(0),
  pagesDone: z.number().int().min(0),
  pagesParsed: z.number().int().min(0),
  pagesSkipped: skipCounts,
  pagesFailed: z.number().int().min(0),
  pagesRunning: z.number().int().min(0),
  pagesPending: z.number().int().min(0),
  /** Every page 1..pagesTotal in order, run-length encoded: [first, last, state]. */
  ranges: z.array(z.tuple([pageNo, pageNo, z.enum(PAGE_COVERAGE_STATES)])),
  ocrRanges: z.array(pageRange),
  skipRanges: z.array(z.tuple([pageNo, pageNo, z.enum(SEGMENT_SKIP_REASONS)])),
  /** Failed segments (first 50), reason in words. */
  failures: z.array(z.object({ segmentId: z.string().nullable(), pages: pageRange, reason: z.string() })),
  segments: z.object({
    total: z.number().int().min(0),
    pending: z.number().int().min(0),
    running: z.number().int().min(0),
    done: z.number().int().min(0),
    parsed: z.number().int().min(0),
    skipped: z.number().int().min(0),
    no_text: z.number().int().min(0),
    failed: z.number().int().min(0),
  }),
  runId: z.string().nullable(),
  /** legacy basis: pages cited by live facts. */
  citedRanges: z.array(pageRange).optional(),
  legacy: extractionEvidence.optional(),
  resume: resumeDecision.optional(),
  report: ingestionReport.optional(),
  /** The lab check (2026-10-08; its own writer, src/server/services/lab-check.ts): the lab lines found and what became of them. */
  labCheck: labCheckReport.optional(),
});
export type DocumentCoverage = z.infer<typeof documentCoverage>;

/** A stored coverage read without ever throwing (null when missing or not this shape). */
export function parseCoverage(metadata: unknown): DocumentCoverage | null {
  const raw = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).coverage : undefined;
  if (!raw) return null;
  const r = documentCoverage.safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * metadata_json with its `coverage` patched, never replaced: computed fields from one writer, `legacy`/`resume`/
 * `report` from theirs. Call inside the same synchronous read-modify-write as the update (better-sqlite3).
 */
export function mergeCoverageMeta(metadata: Record<string, unknown>, patch: Partial<DocumentCoverage>): Record<string, unknown> {
  const prev = metadata.coverage && typeof metadata.coverage === 'object' ? (metadata.coverage as Record<string, unknown>) : {};
  return { ...metadata, coverage: { ...prev, ...patch } };
}

/** Sorted page numbers -> [[first, last], ...]. */
export function pagesToRanges(pages: Iterable<number>): PageRange[] {
  const sorted = [...new Set(pages)].filter((n) => Number.isInteger(n) && n >= 1).sort((a, b) => a - b);
  const out: PageRange[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else out.push([p, p]);
  }
  return out;
}

/** [[1, 48], [61, 61]] -> "pp.1-48, 61" ("p.5" for one page; "" for none). */
export function formatPageRanges(ranges: readonly (readonly [number, number])[]): string {
  if (!ranges.length) return '';
  const single = ranges.length === 1 && ranges[0][0] === ranges[0][1];
  const parts = ranges.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`));
  return `${single ? 'p.' : 'pp.'}${parts.join(', ')}`;
}

/** Per-page states (index 0 = page 1) -> run-length ranges. */
export function encodeStateRanges(states: readonly PageCoverageState[]): Array<[number, number, PageCoverageState]> {
  const out: Array<[number, number, PageCoverageState]> = [];
  states.forEach((s, i) => {
    const last = out[out.length - 1];
    if (last && last[2] === s && last[1] === i) last[1] = i + 1;
    else out.push([i + 1, i + 1, s]);
  });
  return out;
}

/** Ranges -> per-page states (index 0 = page 1); pages not covered by a range read as `pending`. */
export function decodeStateRanges(ranges: readonly (readonly [number, number, PageCoverageState])[], pagesTotal: number): PageCoverageState[] {
  const out: PageCoverageState[] = new Array(Math.max(0, pagesTotal)).fill('pending');
  for (const [a, b, s] of ranges) for (let p = a; p <= b && p <= pagesTotal; p++) out[p - 1] = s;
  return out;
}

/** One page as the coverage sees it. */
export interface CoveragePageInput {
  pageNumber: number;
  hasText: boolean;
  ocr: boolean;
  /** An image block of 10% or more. */
  image?: boolean;
}

/** One segment as the coverage sees it (a document_segments row with its detail parsed). */
export interface CoverageSegmentInput {
  id: string;
  pageStart: number;
  pageEnd: number;
  status: string;
  skipReason?: string | null;
  error?: string | null;
  supersededAt?: string | null;
  detail?: SegmentDetail | null;
}

const UNSETTLED_RANK: Partial<Record<PageCoverageState, number>> = { failed: 3, running: 2, pending: 1 };
const SETTLED_RANK: Partial<Record<PageCoverageState, number>> = { done: 4, parsed: 3, skipped: 2, no_text: 1 };

function statusToPageState(status: string): PageCoverageState {
  return (PAGE_COVERAGE_STATES as readonly string[]).includes(status) ? (status as PageCoverageState) : 'pending';
}

function isSkipReason(r: unknown): r is SegmentSkipReason {
  return typeof r === 'string' && (SEGMENT_SKIP_REASONS as readonly string[]).includes(r);
}

/**
 * A document's coverage from its live segments (superseded rows ignored). A page touched by several segments is
 * failed, running or pending if any of them is (worst first); otherwise it takes the most-read settled state
 * (done > parsed > skipped > no_text). A page no live segment touches is pending. `state`: complete when every page
 * is settled; running when any page is running; unread when nothing was read by the model or failed (parsing alone
 * does not count as reading); partial otherwise.
 */
export function computeCoverage(input: { pagesTotal: number; segments: readonly CoverageSegmentInput[]; pages?: readonly CoveragePageInput[]; runId?: string | null; at: string }): DocumentCoverage {
  const n = Math.max(0, input.pagesTotal);
  const unsettled: number[] = new Array(n).fill(0);
  const settled: Array<PageCoverageState | null> = new Array(n).fill(null);
  const skipReason: Array<SegmentSkipReason | null> = new Array(n).fill(null);
  const touched: boolean[] = new Array(n).fill(false);
  const ocr = new Set<number>();
  const image = new Set<number>();
  const counts = { total: 0, pending: 0, running: 0, done: 0, parsed: 0, skipped: 0, no_text: 0, failed: 0 };
  const failures: DocumentCoverage['failures'] = [];

  for (const seg of input.segments) {
    if (seg.supersededAt) continue;
    counts.total++;
    const st = statusToPageState(seg.status);
    if (st in counts) counts[st as keyof typeof counts]++;
    if (st === 'failed' && failures.length < 50) {
      failures.push({ segmentId: seg.id, pages: [seg.pageStart, seg.pageEnd], reason: seg.error || seg.detail?.failure?.message || 'could not be read' });
    }
    const pageInfo = new Map<number, SegmentPageInfo>();
    for (const pi of seg.detail?.pages ?? []) pageInfo.set(pi.page, pi);
    for (let p = Math.max(1, seg.pageStart); p <= Math.min(n, seg.pageEnd); p++) {
      const i = p - 1;
      touched[i] = true;
      const pi = pageInfo.get(p);
      if (pi?.ocr && !pi.ocr.error && pi.ocr.chars > 0) ocr.add(p);
      if ((pi?.imageCoverage ?? 0) >= 0.1) image.add(p);
      // A page's own state wins over its segment's: a twin or a blank page is decided when the document is cut and is
      // never sent, whatever the segment's state; a page that failed inside a read segment stays failed.
      const own = pi?.state ?? st;
      const u = UNSETTLED_RANK[own];
      if (u) {
        unsettled[i] = Math.max(unsettled[i], u);
        continue;
      }
      const prev = settled[i];
      if (!prev || (SETTLED_RANK[own] ?? 0) > (SETTLED_RANK[prev] ?? 0)) settled[i] = own;
      if (own === 'skipped' || own === 'no_text') {
        const r = pi?.skipReason ?? seg.skipReason ?? (own === 'no_text' ? 'no_text' : null);
        if (isSkipReason(r) && !skipReason[i]) skipReason[i] = r;
      }
    }
  }
  for (const pg of input.pages ?? []) {
    if (pg.pageNumber < 1 || pg.pageNumber > n) continue;
    if (pg.ocr) ocr.add(pg.pageNumber);
    if (pg.image) image.add(pg.pageNumber);
  }

  const states: PageCoverageState[] = [];
  const skipped: SkipCounts = { duplicate: 0, boilerplate: 0, blank: 0, no_text: 0 };
  const skipStates: Array<SegmentSkipReason | null> = [];
  const tally = { done: 0, parsed: 0, failed: 0, running: 0, pending: 0 };
  for (let i = 0; i < n; i++) {
    let s: PageCoverageState;
    if (!touched[i]) s = 'pending';
    else if (unsettled[i] === 3) s = 'failed';
    else if (unsettled[i] === 2) s = 'running';
    else if (unsettled[i] === 1) s = 'pending';
    else s = settled[i] ?? 'pending';
    states.push(s);
    let reason: SegmentSkipReason | null = null;
    if (s === 'skipped' || s === 'no_text') {
      reason = skipReason[i] ?? (s === 'no_text' ? 'no_text' : 'blank');
      skipped[reason]++;
    } else if (s in tally) tally[s as keyof typeof tally]++;
    skipStates.push(reason);
  }

  const skipRanges: DocumentCoverage['skipRanges'] = [];
  skipStates.forEach((r, i) => {
    if (!r) return;
    const last = skipRanges[skipRanges.length - 1];
    if (last && last[2] === r && last[1] === i) last[1] = i + 1;
    else skipRanges.push([i + 1, i + 1, r]);
  });

  const settledCount = n - tally.failed - tally.running - tally.pending;
  let state: CoverageState;
  if (n > 0 && settledCount === n) state = 'complete';
  else if (tally.running > 0) state = 'running';
  else if (tally.done === 0 && tally.failed === 0) state = 'unread';
  else state = 'partial';

  const withText = input.pages ? input.pages.filter((p) => p.hasText).length : null;
  return {
    v: 1,
    at: input.at,
    basis: 'segments',
    state,
    pagesTotal: n,
    pagesWithText: withText,
    pagesOcr: [...ocr].filter((p) => p >= 1 && p <= n).length,
    pagesImage: [...image].filter((p) => p >= 1 && p <= n).length,
    pagesDone: tally.done,
    pagesParsed: tally.parsed,
    pagesSkipped: skipped,
    pagesFailed: tally.failed,
    pagesRunning: tally.running,
    pagesPending: tally.pending,
    ranges: encodeStateRanges(states),
    ocrRanges: pagesToRanges([...ocr].filter((p) => p >= 1 && p <= n)),
    skipRanges,
    failures,
    segments: counts,
    runId: input.runId ?? null,
  };
}

/**
 * Coverage of a document read before segments existed ("legacy, worked out from citations"): pages inside the ranges
 * of calls that came back ok are `done` when they had text; every other page is pending. Never claims more than the
 * calls prove.
 */
export function computeLegacyCoverage(input: { pagesTotal: number; pages?: readonly CoveragePageInput[]; readRanges: readonly (readonly [number, number])[]; citedPages?: Iterable<number>; runId?: string | null; at: string }): DocumentCoverage {
  const n = Math.max(0, input.pagesTotal);
  const hasText = new Map<number, boolean>();
  for (const p of input.pages ?? []) hasText.set(p.pageNumber, p.hasText);
  const read = new Set<number>();
  for (const [a, b] of input.readRanges) for (let p = Math.max(1, a); p <= Math.min(n, b); p++) if (hasText.get(p) !== false) read.add(p);
  const states: PageCoverageState[] = [];
  for (let p = 1; p <= n; p++) states.push(read.has(p) ? 'done' : 'pending');
  const done = read.size;
  const ocr = (input.pages ?? []).filter((p) => p.ocr && p.pageNumber >= 1 && p.pageNumber <= n).map((p) => p.pageNumber);
  return {
    v: 1,
    at: input.at,
    basis: 'legacy',
    state: n > 0 && done === n ? 'complete' : done === 0 ? 'unread' : 'partial',
    pagesTotal: n,
    pagesWithText: input.pages ? input.pages.filter((p) => p.hasText).length : null,
    pagesOcr: ocr.length,
    pagesImage: (input.pages ?? []).filter((p) => p.image).length,
    pagesDone: done,
    pagesParsed: 0,
    pagesSkipped: { duplicate: 0, boilerplate: 0, blank: 0, no_text: 0 },
    pagesFailed: 0,
    pagesRunning: 0,
    pagesPending: n - done,
    ranges: encodeStateRanges(states),
    ocrRanges: pagesToRanges(ocr),
    skipRanges: [],
    failures: [],
    segments: { total: 0, pending: 0, running: 0, done: 0, parsed: 0, skipped: 0, no_text: 0, failed: 0 },
    runId: input.runId ?? null,
    citedRanges: pagesToRanges(input.citedPages ?? []),
  };
}

/** Pages accounted for: read, parsed, skipped with a reason, or with nothing to read. */
export function pagesAccounted(c: Pick<DocumentCoverage, 'pagesDone' | 'pagesParsed' | 'pagesSkipped'>): number {
  return c.pagesDone + c.pagesParsed + c.pagesSkipped.duplicate + c.pagesSkipped.boilerplate + c.pagesSkipped.blank + c.pagesSkipped.no_text;
}

/** The extraction status a finished pass leaves (D.1.1): done only when every page is accounted for. */
export function extractionStatusFor(c: Pick<DocumentCoverage, 'state' | 'pagesDone' | 'pagesFailed'>, opts: { runFailed?: boolean } = {}): 'done' | 'partial' | 'failed' {
  if (c.state === 'complete') return 'done';
  if (opts.runFailed && c.pagesDone === 0) return 'failed';
  return 'partial';
}

// ---------------------------------------------------------------------------
// Exports and copies: `documents.metadata_json.export` and `.containedIn` (no new document category: an export is
// recognised by its structure)
// ---------------------------------------------------------------------------

/** `metadata_json.export`: what the segmenter recognised (written at segmentation). */
export const documentExportInfo = z.object({
  v: z.literal(1),
  at: z.string(),
  system: z.enum(['epic', 'unknown']),
  layout: z.enum(['chart_print', 'health_summary', 'ccd', 'unknown']),
  /** The print stamp as printed ("Printed on ... "), and its day. */
  printedText: z.string().nullable(),
  printedAt: z.string().nullable(),
  /** The institution printed in the running header (the print location, not each encounter's facility). */
  institutionText: z.string().nullable(),
  /** Whether PDF bookmarks gave the encounter boundaries. */
  outline: z.boolean(),
  encounters: z.number().int().min(0),
  segmenter: z.number().int(),
});
export type DocumentExportInfo = z.infer<typeof documentExportInfo>;

/** One entry of `metadata_json.containedIn` on a separately filed document: an export that also holds it. */
export const containedInEntry = z.object({
  documentId: z.string(),
  segmentId: z.string().nullable(),
  pages: pageRange,
  similarity: z.number().min(0).max(1),
  at: z.string(),
});
export type ContainedInEntry = z.infer<typeof containedInEntry>;

/** `metadata_json.export` read without throwing. */
export function parseExportInfo(metadata: unknown): DocumentExportInfo | null {
  const raw = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).export : undefined;
  const r = raw ? documentExportInfo.safeParse(raw) : null;
  return r?.success ? r.data : null;
}

/** `metadata_json.containedIn` read without throwing (entries that do not parse are left out). */
export function parseContainedIn(metadata: unknown): ContainedInEntry[] {
  const raw = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).containedIn : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) => {
    const r = containedInEntry.safeParse(e);
    return r.success ? [r.data] : [];
  });
}

// ---------------------------------------------------------------------------
// Upload: `documents.metadata_json.upload`, and the confirmation the "adding" banner follows
// ---------------------------------------------------------------------------

/** Proof the whole file arrived and every page was stored (written by the ingest job, read-back verified). */
export const uploadRecord = z.object({
  v: z.literal(1),
  at: z.string(),
  /** Bytes the browser said it sent (File.size), when it said. */
  bytesDeclared: z.number().int().min(0).nullable(),
  /** Bytes received and hashed at upload (documents.size_bytes). */
  bytesReceived: z.number().int().min(0),
  /** Bytes read back from the encrypted store at ingest, and whether their SHA-256 equals documents.sha256. */
  bytesStored: z.number().int().min(0).nullable(),
  readBackOk: z.boolean().nullable(),
  sha256: z.string(),
  /** The file's own page count (PDF), null for kinds without pages. */
  pagesInFile: z.number().int().min(0).nullable(),
  /** document_pages rows written. */
  pagesStored: z.number().int().min(0),
  pagesWithText: z.number().int().min(0),
  /** Pages with no text after OCR (first 200). */
  pagesNoText: z.array(pageNo),
  complete: z.boolean(),
  /** Plain words, one per problem ("The file has 1,840 pages; 1,839 were stored."). */
  problems: z.array(z.string()),
});
export type UploadRecord = z.infer<typeof uploadRecord>;

/** A stored upload record read without ever throwing. */
export function parseUploadRecord(metadata: unknown): UploadRecord | null {
  const raw = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).upload : undefined;
  if (!raw) return null;
  const r = uploadRecord.safeParse(raw);
  return r.success ? r.data : null;
}

/** Builds the upload record from what the ingest job saw. `complete` and `problems` are worked out here. */
export function buildUploadRecord(input: { at: string; bytesDeclared?: number | null; bytesReceived: number; bytesStored: number | null; readBackOk: boolean | null; sha256: string; pagesInFile: number | null; pagesStored: number; pagesWithText: number; pagesNoText: readonly number[] }): UploadRecord {
  const problems: string[] = [];
  if (input.bytesDeclared != null && input.bytesDeclared !== input.bytesReceived) problems.push(`${formatBytes(input.bytesDeclared)} were sent; ${formatBytes(input.bytesReceived)} arrived.`);
  if (input.bytesStored != null && input.bytesStored !== input.bytesReceived) problems.push(`${formatBytes(input.bytesReceived)} arrived; ${formatBytes(input.bytesStored)} were stored.`);
  if (input.readBackOk === false) problems.push('The stored copy does not match what arrived.');
  if (input.pagesInFile != null && input.pagesInFile !== input.pagesStored) problems.push(`The file has ${count(input.pagesInFile)} ${plural(input.pagesInFile, 'page')}; ${count(input.pagesStored)} ${input.pagesStored === 1 ? 'was' : 'were'} stored.`);
  return {
    v: 1,
    at: input.at,
    bytesDeclared: input.bytesDeclared ?? null,
    bytesReceived: input.bytesReceived,
    bytesStored: input.bytesStored,
    readBackOk: input.readBackOk,
    sha256: input.sha256,
    pagesInFile: input.pagesInFile,
    pagesStored: input.pagesStored,
    pagesWithText: input.pagesWithText,
    pagesNoText: [...input.pagesNoText].slice(0, 200),
    complete: problems.length === 0 && input.readBackOk !== false,
    problems,
  };
}

/** Where an upload stands, from stored to every page analysed. */
export const UPLOAD_STAGES = ['stored', 'reading', 'read', 'not_requested', 'analysing', 'waiting_for_you', 'complete', 'partial', 'failed'] as const;
export type UploadStage = (typeof UPLOAD_STAGES)[number];

/** GET /api/documents/:id/confirmation (and the batch form): what the "adding" banner shows for one file. */
export const uploadConfirmation = z.object({
  documentId: z.string(),
  title: z.string(),
  stage: z.enum(UPLOAD_STAGES),
  bytesReceived: z.number().int().min(0),
  bytesVerified: z.boolean().nullable(),
  pagesInFile: z.number().int().min(0).nullable(),
  pagesStored: z.number().int().min(0),
  pagesWithText: z.number().int().min(0).nullable(),
  pagesOcr: z.number().int().min(0),
  pagesImage: z.number().int().min(0),
  pagesAnalysed: z.number().int().min(0),
  pagesSkipped: skipCounts,
  pagesFailed: z.number().int().min(0),
  pagesPending: z.number().int().min(0),
  /** Stored whole, every page read, every page analysed. */
  complete: z.boolean(),
  estimateUsd: z.number().nullable(),
  problems: z.array(z.string()),
  /** One plain sentence: "All 1,840 pages read; details from all 1,840 pages (214 scanned pages read by OCR; 31 repeat pages skipped)." */
  sentence: z.string(),
  /** The wrong-patient guard (2026-10-09): held back as "May be someone else's record" (nothing read or filed from it). */
  held: z.boolean().optional(),
  /** "Patient not confirmed on document. ..." or the held words; null when the patient is confirmed or it was never checked. */
  patientNote: z.string().nullable().optional(),
});
export type UploadConfirmation = z.infer<typeof uploadConfirmation>;

function count(n: number): string {
  return n.toLocaleString('en-US');
}

function plural(n: number, word: string, many = `${word}s`): string {
  return n === 1 ? word : many;
}

/** Bytes in words: "980 bytes", "12.4 KB", "115.9 MB", "1.2 GB" (powers of 1000, as the file manager shows). */
export function formatBytes(n: number): string {
  if (n < 1000) return `${count(n)} ${plural(n, 'byte')}`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  do {
    v /= 1000;
    u++;
  } while (v >= 1000 && u < units.length - 1);
  return `${v.toFixed(1)} ${units[u]}`;
}

/** What went into the confirmation. */
export interface ConfirmationInput {
  document: { id: string; title: string; sizeBytes: number; pageCount: number; textStatus: string; textError?: string | null; extractionStatus: string };
  upload: UploadRecord | null;
  coverage: DocumentCoverage | null;
  /** True when details are being pulled out: a reading is queued or running for the document. */
  extractionWanted: boolean;
  /** Why details were not pulled out, in plain words ("Claude is switched off in Settings"), when it is known. */
  notRequestedReason?: string | null;
}

/** The upload confirmation for one document. */
export function buildUploadConfirmation(input: ConfirmationInput): UploadConfirmation {
  const { document: doc, upload, coverage } = input;
  const problems = [...(upload?.problems ?? [])];
  const pagesStored = upload?.pagesStored ?? doc.pageCount;
  const pagesInFile = upload?.pagesInFile ?? null;
  const reading = ['pending', 'extracting', 'ocr_needed', 'ocr_running'].includes(doc.textStatus);
  const textFailed = doc.textStatus === 'failed';
  const skippedTotal = coverage ? coverage.pagesSkipped.duplicate + coverage.pagesSkipped.boilerplate + coverage.pagesSkipped.blank + coverage.pagesSkipped.no_text : 0;
  const analysed = coverage ? pagesAccounted(coverage) : 0;
  const total = coverage?.pagesTotal ?? pagesStored;
  const pending = coverage ? coverage.pagesPending + coverage.pagesRunning : total;

  let stage: UploadStage;
  if (textFailed) stage = 'failed';
  else if (reading) stage = 'reading';
  else if (coverage?.state === 'complete' && (doc.extractionStatus === 'done' || analysed === total)) stage = 'complete';
  // The lab check's question (reading again pages already read) is not about pages waiting to be read.
  else if (coverage?.resume?.decision === 'ask' && coverage.resume.kind !== 'labcheck') stage = 'waiting_for_you';
  else if (doc.extractionStatus === 'queued' || doc.extractionStatus === 'running' || coverage?.state === 'running') stage = 'analysing';
  else if (doc.extractionStatus === 'failed' && analysed === 0) stage = 'failed';
  else if (doc.extractionStatus === 'partial' || doc.extractionStatus === 'failed' || coverage?.state === 'partial') stage = 'partial';
  // Details are pulled out only while a reading is queued or running (`extractionWanted`); a document whose reading
  // was never queued (Claude off, no key, the reading stopped) is settled as not requested, with the reason when known
  // (2026-10-07 review, rev-comms #7). `read` is left for a document read before coverage was recorded: settled too.
  else if (doc.extractionStatus === 'none' || !doc.extractionStatus) stage = input.extractionWanted ? 'analysing' : 'not_requested';
  else stage = 'read';

  const bytesOk = upload ? upload.readBackOk : null;
  const pagesOk = pagesInFile == null || pagesInFile === pagesStored;
  const complete = stage === 'complete' && pagesOk && bytesOk !== false && problems.length === 0;

  // A one-page document reads "The page was read", never "All 1 page read" (integration, 2026-10-07).
  const onePage = pagesOk && pagesStored === 1 && total === 1;
  const read = onePage
    ? 'The page was read'
    : pagesOk
      ? `All ${count(pagesStored)} ${plural(pagesStored, 'page')} read`
      : `${count(pagesStored)} of ${count(pagesInFile ?? pagesStored)} pages read`;
  const ofTotal = `${count(total)} ${plural(total, 'page')}`;
  const extras: string[] = [];
  if (coverage?.pagesOcr) extras.push(`${count(coverage.pagesOcr)} scanned ${plural(coverage.pagesOcr, 'page')} read by OCR`);
  const repeats = (coverage?.pagesSkipped.duplicate ?? 0) + (coverage?.pagesSkipped.boilerplate ?? 0);
  if (repeats) extras.push(`${count(repeats)} repeat ${plural(repeats, 'page')} skipped`);
  if (coverage?.pagesSkipped.blank) extras.push(`${count(coverage.pagesSkipped.blank)} blank ${plural(coverage.pagesSkipped.blank, 'page')}`);
  if (coverage?.pagesSkipped.no_text) extras.push(`${count(coverage.pagesSkipped.no_text)} ${plural(coverage.pagesSkipped.no_text, 'page')} with nothing readable`);
  const tail = extras.length ? ` (${extras.join('; ')})` : '';

  let sentence: string;
  switch (stage) {
    case 'reading':
      sentence = `Stored all ${formatBytes(upload?.bytesReceived ?? doc.sizeBytes)}; reading the pages.`;
      break;
    case 'failed':
      sentence = textFailed
        ? `Could not read the pages${doc.textError ? `: ${doc.textError}` : ''}.`
        : `${read}; pulling out the details stopped before any page was done.`;
      break;
    case 'not_requested':
      sentence = input.notRequestedReason
        ? `${read}; details were not pulled out: ${input.notRequestedReason}. Pull them out from the document's page.`
        : `${read}; details not pulled out yet.`;
      break;
    case 'read':
      // A document read before coverage was recorded: its details exist, the pages they came from are not counted yet.
      sentence = doc.extractionStatus === 'done' && !coverage ? `${read}; details pulled out (the pages they came from are not counted yet).` : `${read}; details not pulled out yet.`;
      break;
    case 'analysing':
      sentence = `${read}; details from ${count(analysed)} of ${ofTotal} so far${tail}.`;
      break;
    case 'waiting_for_you': {
      const usd = coverage?.resume?.estimateUsd;
      // Never two brackets back to back: with the page notes in brackets, the cost follows a comma.
      const cost = usd != null ? (tail ? `, about $${usd.toFixed(2)}` : ` (about $${usd.toFixed(2)})`) : '';
      sentence = `${read}; details from ${count(analysed)} of ${ofTotal}. The other ${count(pending)} wait for your go-ahead${cost}${tail}.`;
      break;
    }
    case 'complete': {
      // "details from all N pages" only when every page gave its details; otherwise how many did, and why the rest
      // did not (2026-10-07 review, rev-comms #14: the export's sentence claimed all 1,840 while 41 were skipped).
      const withDetails = coverage ? coverage.pagesDone + coverage.pagesParsed : total;
      sentence = onePage
        ? `${read}; its details were pulled out${tail}.`
        : withDetails >= total
          ? `${read}; details from all ${ofTotal}${tail}.`
          : `${read}; every page accounted for: details from ${count(withDetails)} ${plural(withDetails, 'page')}${extras.length ? `; ${extras.join('; ')}` : ''}.`;
      break;
    }
    default: {
      const failed = coverage?.pagesFailed ?? 0;
      const notYet = pending ? `; ${count(pending)} not read yet` : '';
      const couldNot = failed ? `; ${count(failed)} could not be read` : '';
      sentence = `${read}; details from ${count(analysed)} of ${ofTotal}${notYet}${couldNot}${tail}.`;
    }
  }
  if (!pagesOk && pagesInFile != null) {
    const msg = `The file has ${count(pagesInFile)} pages; ${count(pagesStored)} ${pagesStored === 1 ? 'was' : 'were'} stored.`;
    if (!problems.includes(msg)) problems.push(msg);
  }

  return {
    documentId: doc.id,
    title: doc.title,
    stage,
    bytesReceived: upload?.bytesReceived ?? doc.sizeBytes,
    bytesVerified: bytesOk,
    pagesInFile,
    pagesStored,
    pagesWithText: coverage?.pagesWithText ?? upload?.pagesWithText ?? null,
    pagesOcr: coverage?.pagesOcr ?? 0,
    pagesImage: coverage?.pagesImage ?? 0,
    pagesAnalysed: analysed,
    pagesSkipped: coverage?.pagesSkipped ?? { duplicate: 0, boilerplate: 0, blank: 0, no_text: 0 },
    pagesFailed: coverage?.pagesFailed ?? 0,
    pagesPending: coverage ? pending : 0,
    complete,
    estimateUsd: coverage?.resume?.estimateUsd ?? null,
    problems,
    sentence,
  };
}

// ---------------------------------------------------------------------------
// Bulk actions by the clinician or the user (one approval for a batch)
// ---------------------------------------------------------------------------

/** POST /api/documents/reprocess, and the assistant's propose_reprocess_many. */
export const reprocessRequest = z.object({
  documentIds: z.array(z.string().trim().min(1)).min(1).max(500),
  /** missing: only what is not read yet (resume); failed: only failed segments; whole: everything again (user work kept); pages: the given ranges. */
  scope: z.enum(['missing', 'failed', 'whole', 'pages']).default('missing'),
  pages: z.array(pageRange).max(200).optional(),
  deep: z.boolean().default(false),
  /** Read the page text (and OCR) again first. */
  reread: z.boolean().default(false),
  reason: z.string().max(LONG_TEXT_MAX).optional(),
  /** user: the user or the chief of staff asked (on a page or in the message); consult: the clinician proposed it unasked. */
  requestedBy: z.enum(['user', 'consult']).default('user'),
  askMessageId: z.string().optional(),
  /** Go ahead above the auto-resume ceiling (the user said yes to the estimate). */
  confirmAboveCeiling: z.boolean().default(false),
});
export type ReprocessRequest = z.infer<typeof reprocessRequest>;
export type ReprocessRequestInput = z.input<typeof reprocessRequest>;

export const reprocessResult = z.object({
  batchId: z.string(),
  queued: z.array(z.object({ documentId: z.string(), jobId: z.string(), scope: z.string(), estimateUsd: z.number().nullable() })),
  /** Above the ceiling and not confirmed: nothing queued, the estimate is shown and the user is asked once. */
  askFirst: z.array(z.object({ documentId: z.string(), estimateUsd: z.number() })),
  skipped: z.array(z.object({ documentId: z.string(), reason: z.string() })),
  /** filings rows recording the request (action 'reprocess'), for the ledger and Undo where it applies. */
  filingIds: z.array(z.string()),
});
export type ReprocessResult = z.infer<typeof reprocessResult>;

/** POST /api/filing/moves (batch), and the assistant's propose_refile_many. */
export const refileManyRequest = z.object({
  items: z.array(z.object({
    documentId: z.string().trim().min(1),
    toCategory: z.enum(DOCUMENT_CATEGORIES),
    reason: z.string().trim().min(1).max(2000),
  })).min(1).max(500),
  source: z.enum(['user', 'consult']).default('consult'),
  askMessageId: z.string().optional(),
  /** Apply at once (the user asked for exactly this in the message); else proposed, approved with one "Approve all". */
  approve: z.boolean().default(false),
});
export type RefileManyRequest = z.infer<typeof refileManyRequest>;
export type RefileManyRequestInput = z.input<typeof refileManyRequest>;

export const refileManyResult = z.object({
  batchId: z.string(),
  filingIds: z.array(z.string()),
  applied: z.number().int().min(0),
  proposed: z.number().int().min(0),
  skipped: z.array(z.object({ documentId: z.string(), reason: z.string() })),
});
export type RefileManyResult = z.infer<typeof refileManyResult>;
