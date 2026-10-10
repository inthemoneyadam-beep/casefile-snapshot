/**
 * PDF and image handling with MuPDF (WASM): page text with line boxes,
 * rasterisation for OCR and the viewer, and OCR of scanned pages through the
 * worker pool. Every MuPDF object is destroyed in a finally block.
 *
 * Large exports (2026-10-07): `scanPdf` lists each page's image blocks (where they sit, how much of the page they
 * cover, a digest of their pixels) and the PDF's bookmarks; `ocrPdfPages` reads the scanned image under a printed
 * header page by page (one failed or stuck page never stops the others). The text layer is never replaced: the
 * segments service appends OCR text to it (reflow.ts OCR_LABEL). In extractPdf, a page whose OCR fails keeps its
 * text layer and says why (`ocrError`); the other pages go on.
 */
import crypto from 'node:crypto';
import * as mupdf from 'mupdf';
import { isAbortError, OCR_PAGE_TIMEOUT_MS, OCR_POOL_SIZE, ocrImage, type OcrWord } from './ocr';

export const SCANNED_PAGE_CHARS = 30;
export const OCR_DPI = 200;
export const OCR_SCALE = OCR_DPI / 72;

export interface PageBox {
  t: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** OCR confidence 0-100; absent for text-layer boxes. */
  c?: number;
}

export interface ExtractedPage {
  pageNumber: number;
  text: string;
  ocr: boolean;
  confidence: number | null;
  width: number | null;
  height: number | null;
  boxes: PageBox[] | null;
  /** OCR of this page failed (plain words); the page keeps whatever text layer it had. */
  ocrError?: string | null;
}

export interface ExtractPdfOptions {
  /** OCR every page, even those with a text layer. */
  forceOcr?: boolean;
  /** Set false to skip OCR entirely (pages are left with their text layer). */
  ocr?: boolean;
  signal?: AbortSignal;
  onPage?: (info: { pageNumber: number; total: number; ocr: boolean }) => void;
}

interface StextLine {
  bbox?: { x: number; y: number; w: number; h: number };
  text?: string;
}
interface StextBlock {
  type?: string;
  lines?: StextLine[];
}

const MAX_TEXT_BOXES = 4000;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const e = new Error('ingestion cancelled');
    e.name = 'AbortError';
    throw e;
  }
}

/** Tidy extracted text without changing its words: trailing spaces, CRLF, runs of blank lines. */
export function tidyText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

function pageTextAndBoxes(page: mupdf.Page): { text: string; boxes: PageBox[] } {
  const st = page.toStructuredText('preserve-whitespace');
  try {
    const json = JSON.parse(st.asJSON()) as { blocks?: StextBlock[] };
    const paras: string[] = [];
    const boxes: PageBox[] = [];
    for (const block of json.blocks ?? []) {
      const lines = block.lines ?? [];
      const texts: string[] = [];
      for (const line of lines) {
        const t = (line.text ?? '').replace(/\s+$/g, '');
        if (!t.trim()) continue;
        texts.push(t);
        if (line.bbox && boxes.length < MAX_TEXT_BOXES) {
          const b = line.bbox;
          boxes.push({ t: t.trim(), x0: round(b.x), y0: round(b.y), x1: round(b.x + b.w), y1: round(b.y + b.h) });
        }
      }
      if (texts.length) paras.push(texts.join('\n'));
    }
    return { text: tidyText(paras.join('\n\n')), boxes };
  } finally {
    st.destroy();
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function renderPagePng(page: mupdf.Page, scale: number): { png: Buffer; width: number; height: number } {
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
  try {
    const u8 = pix.asPNG();
    return { png: Buffer.from(u8), width: pix.getWidth(), height: pix.getHeight() };
  } finally {
    pix.destroy();
  }
}

export function pdfPageCount(buffer: Buffer): number {
  const doc = mupdf.Document.openDocument(buffer, 'application/pdf');
  try {
    return doc.countPages();
  } finally {
    doc.destroy();
  }
}

/** Render one page (1-based) of a PDF, or of any image MuPDF can open, to PNG. */
export function renderDocumentPagePng(buffer: Buffer, mime: string, pageNumber: number, scale: number): { png: Buffer; width: number; height: number } {
  const doc = mupdf.Document.openDocument(buffer, mime);
  try {
    const n = doc.countPages();
    if (pageNumber < 1 || pageNumber > n) throw new RangeError(`page ${pageNumber} out of range (1-${n})`);
    const page = doc.loadPage(pageNumber - 1);
    try {
      return renderPagePng(page, scale);
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}

/** Pixel size of an image, or null when MuPDF cannot decode it. */
export function imageSize(buffer: Buffer): { width: number; height: number } | null {
  try {
    const img = new mupdf.Image(buffer);
    try {
      return { width: img.getWidth(), height: img.getHeight() };
    } finally {
      img.destroy();
    }
  } catch {
    return null;
  }
}

/** Scale OCR word boxes (image pixels) back to the page's coordinate space. */
export function scaleWords(words: OcrWord[], scale: number): PageBox[] {
  return words.map((w) => ({ t: w.t, x0: round(w.x0 / scale), y0: round(w.y0 / scale), x1: round(w.x1 / scale), y1: round(w.y1 / scale), c: w.c }));
}

/**
 * Extract every page of a PDF. Pages with fewer than SCANNED_PAGE_CHARS
 * characters of text layer are rendered at OCR_DPI and OCRed; their boxes are
 * scaled back to PDF points so the viewer can map them later.
 */
export async function extractPdf(buffer: Buffer, opts: ExtractPdfOptions = {}): Promise<{ pages: ExtractedPage[]; ocrApplied: boolean; ocrPages: number }> {
  const doOcr = opts.ocr !== false;
  const doc = mupdf.Document.openDocument(buffer, 'application/pdf');
  const pages: ExtractedPage[] = [];
  let ocrPages = 0;
  try {
    const total = doc.countPages();
    for (let i = 0; i < total; i++) {
      throwIfAborted(opts.signal);
      const pageNumber = i + 1;
      const page = doc.loadPage(i);
      let png: Buffer | null = null;
      let width: number | null = null;
      let height: number | null = null;
      let layer: { text: string; boxes: PageBox[] };
      try {
        const [x0, y0, x1, y1] = page.getBounds();
        width = round(x1 - x0);
        height = round(y1 - y0);
        layer = pageTextAndBoxes(page);
        const needsOcr = doOcr && (opts.forceOcr || layer.text.replace(/\s+/g, '').length < SCANNED_PAGE_CHARS);
        if (needsOcr) png = renderPagePng(page, OCR_SCALE).png;
      } finally {
        page.destroy();
      }
      if (png) {
        opts.onPage?.({ pageNumber, total, ocr: true });
        let r: Awaited<ReturnType<typeof ocrImage>>;
        try {
          r = await ocrImage(png, { signal: opts.signal, timeoutMs: OCR_PAGE_TIMEOUT_MS });
        } catch (err) {
          // One page that cannot be read never fails the others: it keeps its text layer (maybe none) and says why.
          if (isAbortError(err) || opts.signal?.aborted) throw err;
          png = null;
          pages.push({ pageNumber, text: layer.text, ocr: false, confidence: null, width, height, boxes: layer.boxes.length ? layer.boxes : null, ocrError: ocrErrorWords(err) });
          continue;
        }
        png = null;
        ocrPages++;
        const text = tidyText(r.text);
        // A thin but real text layer that says more than the OCR did is kept as-is.
        if (!opts.forceOcr && layer.text.length > 0 && layer.text.replace(/\s+/g, '').length >= text.replace(/\s+/g, '').length) {
          ocrPages--;
          pages.push({ pageNumber, text: layer.text, ocr: false, confidence: null, width, height, boxes: layer.boxes.length ? layer.boxes : null });
        } else {
          pages.push({ pageNumber, text, ocr: true, confidence: r.confidence, width, height, boxes: scaleWords(r.words, OCR_SCALE) });
        }
      } else {
        opts.onPage?.({ pageNumber, total, ocr: false });
        pages.push({ pageNumber, text: layer.text, ocr: false, confidence: null, width, height, boxes: layer.boxes.length ? layer.boxes : null });
      }
    }
  } finally {
    doc.destroy();
  }
  return { pages, ocrApplied: ocrPages > 0, ocrPages };
}

/** OCR a standalone image document (png/jpg/webp/bmp/tiff). Boxes are in image pixels. */
export async function extractImage(buffer: Buffer, opts: { signal?: AbortSignal } = {}): Promise<ExtractedPage> {
  const size = imageSize(buffer);
  const r = await ocrImage(buffer, { signal: opts.signal });
  return {
    pageNumber: 1,
    text: tidyText(r.text),
    ocr: true,
    confidence: r.confidence,
    width: size?.width ?? null,
    height: size?.height ?? null,
    boxes: scaleWords(r.words, 1),
  };
}

/** An OCR failure in plain words (no record text). */
export function ocrErrorWords(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `the scanned image could not be read: ${msg}`.slice(0, 300);
}

// ---------------------------------------------------------------------------
// Page scan: image blocks, their digests and coverage, and the bookmarks (2026-10-07)
// ---------------------------------------------------------------------------

/** Image blocks smaller than this share of the page (logos, icons) do not count toward its coverage. */
export const IMAGE_MIN_SHARE = 0.01;
/** OCR runs on a page whose images cover at least this share of it (findings D.1.4). */
export const OCR_IMAGE_SHARE = 0.1;

export type Rect = [number, number, number, number];

export interface PdfImageBlock {
  /** Where it is drawn, in page points. */
  bbox: Rect;
  /** Share of the page it covers, 0-1. */
  share: number;
  /** SHA-256 of its decoded pixels and size (32 hex characters): two scans under the same text differ. */
  digest: string;
  width: number;
  height: number;
}

export interface PdfPageScan {
  pageNumber: number;
  width: number;
  height: number;
  images: PdfImageBlock[];
  /** Share of the page covered by images of at least IMAGE_MIN_SHARE, 0-1. */
  imageCoverage: number;
}

/** One bookmark, flattened in order (depth 0 = top level). */
export interface PdfOutlineNode {
  depth: number;
  title: string;
  /** 1-based page, null when the bookmark does not point at a page. */
  page: number | null;
}

export interface PdfScan {
  pageCount: number;
  pages: PdfPageScan[];
  outline: PdfOutlineNode[];
  info: { title: string | null; creator: string | null; producer: string | null };
}

function rectOf(b: unknown): Rect | null {
  if (Array.isArray(b) && b.length >= 4 && b.every((x) => typeof x === 'number')) return [b[0], b[1], b[2], b[3]];
  if (b && typeof b === 'object') {
    const o = b as Record<string, number>;
    if (typeof o.x === 'number' && typeof o.w === 'number') return [o.x, o.y, o.x + o.w, o.y + o.h];
  }
  return null;
}

function imageDigest(image: mupdf.Image): { digest: string; width: number; height: number } {
  const width = image.getWidth();
  const height = image.getHeight();
  const h = crypto.createHash('sha256').update(`${width}x${height}:`);
  let pix: mupdf.Pixmap | null = null;
  try {
    pix = image.toPixmap();
    h.update(pix.getPixels());
  } catch {
    // Undecodable: the size alone, plus a marker (such a page is never skipped anyway: it carries an image).
    h.update('undecodable');
  } finally {
    pix?.destroy();
  }
  return { digest: h.digest('hex').slice(0, 32), width, height };
}

/** The bookmarks of an open document, flattened in order. Never throws (no bookmarks: []). */
export function readOutline(doc: mupdf.Document): PdfOutlineNode[] {
  const out: PdfOutlineNode[] = [];
  let items: ReturnType<mupdf.Document['loadOutline']> = null;
  try {
    items = doc.loadOutline();
  } catch {
    return out;
  }
  const walk = (list: NonNullable<typeof items>, depth: number) => {
    for (const it of list) {
      let page: number | null = typeof it.page === 'number' && it.page >= 0 ? it.page + 1 : null;
      if (page === null && it.uri) {
        try {
          const n = doc.resolveLink(it.uri);
          if (typeof n === 'number' && n >= 0) page = n + 1;
        } catch {
          page = null;
        }
      }
      out.push({ depth, title: (it.title ?? '').replace(/\s+/g, ' ').trim(), page });
      if (it.down?.length) walk(it.down, depth + 1);
    }
  };
  walk(items ?? [], 0);
  return out;
}

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * Lists every page's image blocks (with a digest of their pixels unless `digests: false`) and the bookmarks. About 5 ms
 * a page; yields to the event loop as it goes and stops when `signal` aborts.
 */
export async function scanPdf(buffer: Buffer, opts: { signal?: AbortSignal; onPage?: (pageNumber: number, total: number) => void; digests?: boolean } = {}): Promise<PdfScan> {
  const doc = mupdf.Document.openDocument(buffer, 'application/pdf');
  try {
    const total = doc.countPages();
    const meta = (k: string) => {
      try {
        return doc.getMetaData(k) || null;
      } catch {
        return null;
      }
    };
    const pages: PdfPageScan[] = [];
    for (let i = 0; i < total; i++) {
      throwIfAborted(opts.signal);
      if (i % 25 === 24) await yieldToLoop();
      const page = doc.loadPage(i);
      try {
        const [x0, y0, x1, y1] = page.getBounds();
        const width = round(x1 - x0);
        const height = round(y1 - y0);
        const area = Math.max(1, width * height);
        const images: PdfImageBlock[] = [];
        const st = page.toStructuredText('preserve-whitespace,preserve-images');
        try {
          st.walk({
            onImageBlock(bbox: unknown, _m: unknown, image: mupdf.Image) {
              try {
                const r = rectOf(bbox);
                if (!r) return;
                const cx0 = Math.max(x0, r[0]);
                const cy0 = Math.max(y0, r[1]);
                const cx1 = Math.min(x1, r[2]);
                const cy1 = Math.min(y1, r[3]);
                const share = (Math.max(0, cx1 - cx0) * Math.max(0, cy1 - cy0)) / area;
                // Without digests (counting only) each block gets a placeholder unique to its page and place.
                const d = opts.digests === false ? { digest: `nodigest-${i + 1}-${images.length}`, width: image.getWidth(), height: image.getHeight() } : imageDigest(image);
                images.push({ bbox: [round(r[0]), round(r[1]), round(r[2]), round(r[3])], share: Math.round(share * 1000) / 1000, ...d });
              } finally {
                image.destroy();
              }
            },
          } as Parameters<mupdf.StructuredText['walk']>[0]);
        } finally {
          st.destroy();
        }
        const coverage = Math.min(1, images.filter((im) => im.share >= IMAGE_MIN_SHARE).reduce((n, im) => n + im.share, 0));
        pages.push({ pageNumber: i + 1, width, height, images, imageCoverage: Math.round(coverage * 1000) / 1000 });
      } finally {
        page.destroy();
      }
      opts.onPage?.(i + 1, total);
    }
    return { pageCount: total, pages, outline: readOutline(doc), info: { title: meta('info:Title'), creator: meta('info:Creator'), producer: meta('info:Producer') } };
  } finally {
    doc.destroy();
  }
}

/** The union of a page's image blocks large enough to count, or null when it has none. */
export function imageRegion(scan: Pick<PdfPageScan, 'images'>): Rect | null {
  const big = scan.images.filter((im) => im.share >= IMAGE_MIN_SHARE);
  if (!big.length) return null;
  return [Math.min(...big.map((b) => b.bbox[0])), Math.min(...big.map((b) => b.bbox[1])), Math.max(...big.map((b) => b.bbox[2])), Math.max(...big.map((b) => b.bbox[3]))];
}

/** Renders a page, or only `region` of it (page points), at `scale` to PNG. */
export function renderRegionPng(page: mupdf.Page, region: Rect | null, scale: number): Buffer {
  if (!region) return renderPagePng(page, scale).png;
  const [px0, py0, px1, py1] = page.getBounds();
  const r: Rect = [Math.max(px0, region[0]), Math.max(py0, region[1]), Math.min(px1, region[2]), Math.min(py1, region[3])];
  if (r[2] - r[0] < 4 || r[3] - r[1] < 4) return renderPagePng(page, scale).png;
  const bbox: Rect = [Math.floor(r[0] * scale), Math.floor(r[1] * scale), Math.ceil(r[2] * scale), Math.ceil(r[3] * scale)];
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false);
  try {
    pix.clear(255);
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    try {
      page.run(dev, mupdf.Matrix.scale(scale, scale));
      dev.close();
    } finally {
      dev.destroy();
    }
    return Buffer.from(pix.asPNG());
  } finally {
    pix.destroy();
  }
}

/** One page to read by OCR: the whole page, or only the region its images cover. */
export interface OcrTarget {
  pageNumber: number;
  region: Rect | null;
}

export interface PageOcrResult {
  pageNumber: number;
  text: string;
  confidence: number | null;
  error: string | null;
}

/**
 * OCR of several pages of one PDF, each isolated: a page that fails or takes longer than `timeoutMs` gets an `error`
 * in plain words and the others go on. Renders a few pages ahead of the worker pool, never all at once. Throws only
 * when cancelled.
 */
export async function ocrPdfPages(buffer: Buffer, targets: readonly OcrTarget[], opts: { signal?: AbortSignal; timeoutMs?: number; onPage?: (done: number, total: number, pageNumber: number) => void } = {}): Promise<PageOcrResult[]> {
  if (!targets.length) return [];
  const doc = mupdf.Document.openDocument(buffer, 'application/pdf');
  const results: PageOcrResult[] = [];
  const inFlight = new Set<Promise<void>>();
  const ahead = Math.max(2, OCR_POOL_SIZE + 1);
  let done = 0;
  let aborted: unknown = null;
  try {
    const total = doc.countPages();
    for (const t of targets) {
      throwIfAborted(opts.signal);
      if (aborted) throw aborted;
      if (t.pageNumber < 1 || t.pageNumber > total) {
        results.push({ pageNumber: t.pageNumber, text: '', confidence: null, error: 'no such page in the file' });
        continue;
      }
      let png: Buffer | null = null;
      let renderError: string | null = null;
      const page = doc.loadPage(t.pageNumber - 1);
      try {
        png = renderRegionPng(page, t.region, OCR_SCALE);
      } catch (err) {
        renderError = `the page could not be drawn for reading: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
      } finally {
        page.destroy();
      }
      if (!png) {
        results.push({ pageNumber: t.pageNumber, text: '', confidence: null, error: renderError });
        continue;
      }
      const task: Promise<void> = ocrImage(png, { signal: opts.signal, timeoutMs: opts.timeoutMs ?? OCR_PAGE_TIMEOUT_MS })
        .then((r) => {
          results.push({ pageNumber: t.pageNumber, text: tidyText(r.text), confidence: r.confidence, error: null });
        })
        .catch((err: unknown) => {
          if (isAbortError(err) || opts.signal?.aborted) aborted = err;
          else results.push({ pageNumber: t.pageNumber, text: '', confidence: null, error: ocrErrorWords(err) });
        })
        .finally(() => {
          done++;
          opts.onPage?.(done, targets.length, t.pageNumber);
          inFlight.delete(task);
        });
      inFlight.add(task);
      if (inFlight.size >= ahead) await Promise.race(inFlight);
    }
    await Promise.all(inFlight);
    if (aborted) throw aborted;
  } finally {
    doc.destroy();
  }
  return results.sort((a, b) => a.pageNumber - b.pageNumber);
}
