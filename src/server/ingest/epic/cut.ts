/**
 * The glue between stored pages and the segmenter / parsers, without the database: stored pages + the page scan ->
 * the segmenter's pages; a segment -> its own lines in reading order (its line range applied, furniture removed) and
 * the OCR text it holds. The segments service and the tests use the same functions. Pure.
 */
import { encounterKeyOf, type EncounterRef, type SegmentDetail, type SegmentPageInfo } from '../../../shared/schemas/segments';
import { imageRegion, type PdfScan } from '../pdf';
import { pageReading } from '../reflow';
import { classifyRows, type FurnitureModel } from './furniture';
import { pageLines, type SegLine } from './lines';
import { ownsRow, type SegmenterPage } from './segment';

export interface StoredPage {
  pageNumber: number;
  text: string;
  ocr: boolean;
  confidence: number | null;
  boxesJson: string | null;
}

/** The furniture a segmentation recorded (metadata_json.segmentation.furniture), as a model. */
export function furnitureModelFrom(f: { epic?: boolean; header?: string[]; footer?: string[]; printedText?: string | null; institutionText?: string | null; patientName?: string | null; bannerCentre?: number } | null | undefined): FurnitureModel {
  return {
    ...(typeof f?.bannerCentre === 'number' ? { bannerCentre: f.bannerCentre } : {}),
    epic: Boolean(f?.epic),
    header: new Set(f?.header ?? []),
    footer: new Set(f?.footer ?? []),
    printedText: f?.printedText ?? null,
    institutionText: f?.institutionText ?? null,
    patientName: f?.patientName ?? null,
  };
}

function sameDigests(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return [...(a ?? [])].sort().join(',') === [...(b ?? [])].sort().join(',');
}

/** Stored pages and the page scan (when the original could be read) as the segmenter's pages. */
export function segmenterPagesOf(
  pages: readonly StoredPage[],
  scan: PdfScan | null,
  opts: { previous?: ReadonlyMap<number, SegmentPageInfo>; ocrInfo?: ReadonlyMap<number, NonNullable<SegmentPageInfo['ocr']>>; ocrTries?: ReadonlyMap<number, number> } = {},
): SegmenterPage[] {
  return pages.map((p) => {
    const reading = pageReading(p);
    const sp = scan?.pages[p.pageNumber - 1];
    const before = opts.previous?.get(p.pageNumber);
    const digests = sp ? sp.images.map((im) => im.digest) : before?.imageDigests ?? [];
    const region = sp ? imageRegion(sp) : null;
    const carried = before?.ocr && sameDigests(before.imageDigests, digests) ? before.ocr : null;
    return {
      page: p.pageNumber,
      rows: reading.rows,
      source: reading.source,
      storedText: p.text,
      ocr: reading.ocr,
      imageDigests: digests,
      imageCoverage: sp ? sp.imageCoverage : before?.imageCoverage ?? 0,
      imageTop: region ? region[1] : null,
      ocrInfo: opts.ocrInfo?.get(p.pageNumber) ?? carried,
      ocrTries: opts.ocrTries?.get(p.pageNumber),
    };
  });
}

/** A segment's own lines on each of its pages, in reading order, and the OCR text of the images it holds. */
export function segmentLinesOf(segment: { pageStart: number; pageEnd: number }, detail: SegmentDetail, pages: readonly StoredPage[], model: FurnitureModel): { lines: SegLine[]; ocrByPage: Map<number, string> } {
  const lines: SegLine[] = [];
  const ocrByPage = new Map<number, string>();
  const infos = new Map((detail.pages ?? []).map((p) => [p.page, p]));
  for (const p of pages) {
    if (p.pageNumber < segment.pageStart || p.pageNumber > segment.pageEnd) continue;
    const reading = pageReading(p);
    const classes = classifyRows(reading.rows, model);
    let pl = pageLines({ page: p.pageNumber, rows: reading.rows, classes, source: reading.source });
    const startLine = p.pageNumber === segment.pageStart ? detail.startLine : undefined;
    const endLine = p.pageNumber === segment.pageEnd ? detail.endLine : undefined;
    if (startLine !== undefined) pl = pl.filter((l) => l.rowIndex >= startLine);
    if (endLine !== undefined) pl = pl.filter((l) => l.rowIndex <= endLine);
    lines.push(...pl);
    if (reading.ocr) {
      const imageRow = (infos.get(p.pageNumber) as Record<string, unknown> | undefined)?.imageRow;
      if (ownsRow(typeof imageRow === 'number' ? imageRow : Number.MAX_SAFE_INTEGER, startLine, endLine)) ocrByPage.set(p.pageNumber, reading.ocr);
    }
  }
  return { lines, ocrByPage };
}

/** The printed fields of a segment (a document_segments row or a draft). */
export interface SegmentEncounterFields {
  pageStart: number;
  pageEnd: number;
  headerText: string | null;
  encounterDate: string | null;
  encounterDatePrecision: string;
  encounterDateText: string | null;
  encounterType: string | null;
  department: string | null;
  encounterNumber: string | null;
}

/**
 * The encounter a segment belongs to, as the parsers cite it. An encounter printed in two places: its later part is
 * cited as the first (one key, one start page, so its messages join the same threads).
 */
export function encounterRefFor(seg: SegmentEncounterFields, detail: SegmentDetail): EncounterRef {
  const pages = detail.encounterPages ?? [seg.pageStart, seg.pageEnd];
  const sameAs = (detail as Record<string, unknown>).encounterSameAs;
  const keyed = typeof sameAs === 'string' ? /^p(\d+)$/.exec(sameAs) : null;
  const startPage = keyed ? Number(keyed[1]) : pages[0];
  const precision = (['day', 'month', 'year', 'unknown'] as const).includes(seg.encounterDatePrecision as 'day') ? (seg.encounterDatePrecision as EncounterRef['datePrecision']) : 'unknown';
  return {
    key: keyed ? encounterKeyOf(startPage) : detail.encounterKey ?? encounterKeyOf(pages[0]),
    headerText: seg.headerText,
    date: seg.encounterDate,
    datePrecision: precision,
    dateText: seg.encounterDateText,
    type: seg.encounterType,
    department: seg.department,
    number: seg.encounterNumber,
    startPage,
    endPage: Math.max(pages[1], startPage),
  };
}
