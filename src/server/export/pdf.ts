/**
 * PDF assembly for packets. Two independent pieces:
 *  - htmlToPdfWithBrowser: drives the Edge/Chrome already on the machine, or
 *    Chromium in the hosted container (puppeteer-core, headless; without
 *    Chromium's sandbox there, see browserNeedsNoSandbox) to print the packet
 *    HTML to a Letter PDF.
 *  - appendOriginals: pdf-lib merges the selected originals after the
 *    HTML part, one image per page, and stamps every appended page with its
 *    document number and packet page so references resolve on paper.
 * Both are injectable so the export job can be tested without a browser.
 */
import fs from 'node:fs';
import * as mupdf from 'mupdf';
import { PDFDocument, StandardFonts, rgb, type PDFPage } from 'pdf-lib';
import { renderDocumentPagePng } from '../ingest/pdf';
import { config } from '../config';
import type { AppendixKind } from './types';

/** Edge or Chrome on Windows (the local app). */
export const WINDOWS_BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

/** Chromium in the container (Dockerfile: Debian's chromium package) or Chrome on a Linux machine. */
export const LINUX_BROWSER_CANDIDATES = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];

/** Checked in order; the first that exists is used (a path of the other system never exists, so one list serves both). */
export const BROWSER_CANDIDATES = [...WINDOWS_BROWSER_CANDIDATES, ...LINUX_BROWSER_CANDIDATES];

/**
 * The browser that prints packets: CASEFILE_CHROME_PATH, else CASEFILE_BROWSER (the older name), else the first
 * candidate that exists; null when there is none (packets are then stored as HTML).
 */
export function findBrowserExecutable(candidates: readonly string[] = BROWSER_CANDIDATES, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of ['CASEFILE_CHROME_PATH', 'CASEFILE_BROWSER']) {
    const given = env[name]?.trim();
    if (given && fs.existsSync(given)) return given;
  }
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

/** True when the browser runs in a container or as root on Linux, where Chromium's own sandbox cannot start. */
export function browserNeedsNoSandbox(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'linux') return false;
  if (/^(1|true|yes)$/i.test(env.CASEFILE_CHROME_NO_SANDBOX?.trim() ?? '')) return true;
  if (config.hosted) return true;
  try {
    if (process.getuid?.() === 0) return true;
  } catch {
    // ignore
  }
  return fs.existsSync('/.dockerenv');
}

/** The command-line switches the packet browser starts with. */
export function browserLaunchArgs(noSandbox = browserNeedsNoSandbox()): string[] {
  const args = ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu', '--disable-sync', '--disable-background-networking', '--mute-audio', '--hide-scrollbars'];
  // In a container: no setuid sandbox, and /dev/shm is small, so shared memory goes to /tmp.
  if (noSandbox) args.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage');
  return args;
}

export interface HtmlToPdfOptions {
  executablePath: string;
  /** Shown in the running footer with the page number. */
  footerText?: string;
  timeoutMs?: number;
  /** Closes the browser when aborted (a lock or a cancel), so the job ends promptly instead of printing on. */
  signal?: AbortSignal;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Print `html` to a Letter PDF with the browser at `executablePath`. */
export async function htmlToPdfWithBrowser(html: string, opts: HtmlToPdfOptions): Promise<Buffer> {
  if (opts.signal?.aborted) throw new Error('cancelled');
  const puppeteer = await import('puppeteer-core');
  const timeout = opts.timeoutMs ?? 180_000;
  const browser = await puppeteer.launch({
    executablePath: opts.executablePath,
    headless: true,
    timeout: 60_000,
    protocolTimeout: timeout,
    args: browserLaunchArgs(),
  });
  const onAbort = () => void browser.close().catch(() => undefined);
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (opts.signal?.aborted) throw new Error('cancelled');
    const page = await browser.newPage();
    // Nothing in the packet may fetch from the network; refuse any request that is not the document itself.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('about:') || url.startsWith('data:')) void req.continue();
      else void req.abort();
    });
    await page.setContent(html, { waitUntil: 'load', timeout });
    await page.emulateMediaType('print');
    const footer = opts.footerText ? escHtml(opts.footerText) : '';
    const bytes = await page.pdf({
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: '0.6in', right: '0.6in', bottom: '0.75in', left: '0.6in' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;margin:0 0.6in;font-family:Arial,Helvetica,sans-serif;font-size:7.5px;color:#666;display:flex;justify-content:space-between;"><span>${footer}</span><span>packet page <span class="pageNumber"></span></span></div>`,
      timeout,
    });
    return Buffer.from(bytes);
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    await browser.close().catch(() => undefined);
  }
}

export async function pdfPageCountOf(bytes: Buffer): Promise<number> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return doc.getPageCount();
}

export interface AppendItem {
  n: number;
  documentId: string;
  title: string;
  kind: AppendixKind;
  mime: string;
  /** Declared page count from the ledger (used only as a hint for multi-page images). */
  pageCount: number;
  bytes: Buffer;
}

export interface AppendedInfo {
  n: number;
  documentId: string;
  title: string;
  pages: number;
  startPage: number | null;
  how: AppendixKind | 'failed';
  error?: string;
}

export interface AppendOptions {
  /** Label stamped on each appended page; receives the item, the page within it (1-based), its page count and the packet page. */
  stamp?: (item: AppendItem, pageInDoc: number, pagesInDoc: number, packetPage: number) => string;
  onProgress?: (index: number, total: number) => void;
  signal?: AbortSignal;
}

const LETTER: [number, number] = [612, 792];
const IMAGE_MARGIN = 36;

/** Count the pages MuPDF sees in an image container (TIFF can hold many); 1 when it cannot say. */
function imagePageCount(bytes: Buffer, mime: string, hint: number): number {
  try {
    const doc = mupdf.Document.openDocument(bytes, mime);
    try {
      return Math.max(1, doc.countPages());
    } finally {
      doc.destroy();
    }
  } catch {
    return Math.max(1, hint);
  }
}

/**
 * The bytes of an encrypted PDF re-saved without encryption (vector text kept).
 * Owner-password / restriction encryption with an empty user password opens
 * without asking; a PDF that needs a user password throws, so the caller falls
 * back to rasterising (which then fails into the placeholder page).
 */
function decryptPdf(bytes: Buffer): Buffer {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  try {
    if (doc.needsPassword() && !doc.authenticatePassword('')) throw new Error('the PDF needs a password to open');
    const pdf = doc.asPDF();
    if (!pdf) throw new Error('not a PDF');
    return Buffer.from(pdf.saveToBuffer('encrypt=none').asUint8Array());
  } finally {
    doc.destroy();
  }
}

async function embedImagePage(out: PDFDocument, item: AppendItem, pageNumber: number): Promise<PDFPage> {
  let png: Buffer | null = null;
  let jpg: Buffer | null = null;
  if (pageNumber === 1 && item.mime === 'image/png') png = item.bytes;
  else if (pageNumber === 1 && item.mime === 'image/jpeg') jpg = item.bytes;
  else png = renderDocumentPagePng(item.bytes, item.mime, pageNumber, 1).png;
  const image = png ? await out.embedPng(png) : await out.embedJpg(jpg!);
  const page = out.addPage(LETTER);
  const maxW = LETTER[0] - IMAGE_MARGIN * 2;
  const maxH = LETTER[1] - IMAGE_MARGIN * 2 - 14;
  const scale = Math.min(maxW / image.width, maxH / image.height, 1);
  const w = image.width * scale;
  const h = image.height * scale;
  page.drawImage(image, { x: (LETTER[0] - w) / 2, y: LETTER[1] - IMAGE_MARGIN - h, width: w, height: h });
  return page;
}

/**
 * Append originals to `basePdf`. PDFs are copied page by page (falling back
 * to rasterised pages when pdf-lib cannot parse one); images get one Letter
 * page each. A document that cannot be embedded at all gets a single page
 * saying so, so the index stays truthful.
 */
export async function appendOriginals(basePdf: Buffer, items: AppendItem[], opts: AppendOptions = {}): Promise<{ bytes: Buffer; pageCount: number; appended: AppendedInfo[] }> {
  const out = await PDFDocument.load(basePdf, { ignoreEncryption: true, updateMetadata: false });
  const font = await out.embedFont(StandardFonts.Helvetica);
  const appended: AppendedInfo[] = [];
  let packetPage = out.getPageCount();

  const stampPage = (page: PDFPage, text: string) => {
    const { width } = page.getSize();
    const size = 7;
    const tw = font.widthOfTextAtSize(text, size);
    const x = Math.max(8, width - tw - 18);
    page.drawRectangle({ x: x - 3, y: 6, width: tw + 6, height: 11, color: rgb(1, 1, 1), opacity: 0.85, borderWidth: 0 });
    page.drawText(text, { x, y: 9, size, font, color: rgb(0.25, 0.25, 0.25) });
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (opts.signal?.aborted) throw new Error('cancelled');
    opts.onProgress?.(i, items.length);
    const startPage = packetPage + 1;
    const pages: PDFPage[] = [];
    let how: AppendixKind | 'failed' = item.kind;
    let error: string | undefined;
    try {
      if (item.kind === 'pdf') {
        try {
          let src = await PDFDocument.load(item.bytes, { ignoreEncryption: true, updateMetadata: false });
          if (src.isEncrypted) {
            // pdf-lib never decrypts: copied pages would keep encrypted streams in an
            // unencrypted file and print blank. Let MuPDF remove the encryption first.
            src = await PDFDocument.load(decryptPdf(item.bytes), { updateMetadata: false });
            error = 'encrypted original decrypted for embedding';
          }
          const copied = await out.copyPages(src, src.getPageIndices());
          for (const p of copied) pages.push(out.addPage(p));
        } catch (err) {
          // pdf-lib could not parse it; rasterise with MuPDF instead.
          const msg = err instanceof Error ? err.message : String(err);
          let n = 0;
          for (let p = 1; p <= 2000; p++) {
            let png: Buffer;
            try {
              png = renderDocumentPagePng(item.bytes, 'application/pdf', p, 1.5).png;
            } catch {
              break;
            }
            const image = await out.embedPng(png);
            const page = out.addPage(LETTER);
            const scale = Math.min((LETTER[0] - IMAGE_MARGIN * 2) / image.width, (LETTER[1] - IMAGE_MARGIN * 2 - 14) / image.height);
            const w = image.width * scale;
            const h = image.height * scale;
            page.drawImage(image, { x: (LETTER[0] - w) / 2, y: LETTER[1] - IMAGE_MARGIN - h, width: w, height: h });
            pages.push(page);
            n++;
          }
          if (!n) throw new Error(`could not read PDF: ${msg}`);
          error = `copied as images: ${msg}`;
        }
      } else {
        const count = imagePageCount(item.bytes, item.mime, item.pageCount);
        for (let p = 1; p <= count; p++) {
          try {
            pages.push(await embedImagePage(out, item, p));
          } catch (err) {
            if (p === 1) throw err;
            break;
          }
        }
      }
    } catch (err) {
      how = 'failed';
      error = err instanceof Error ? err.message : String(err);
      const page = out.addPage(LETTER);
      page.drawText(`Document D${item.n} could not be embedded.`, { x: 48, y: 720, size: 12, font, color: rgb(0.1, 0.1, 0.1) });
      page.drawText(item.title.slice(0, 120), { x: 48, y: 700, size: 10, font, color: rgb(0.2, 0.2, 0.2) });
      page.drawText(error.slice(0, 160), { x: 48, y: 680, size: 8, font, color: rgb(0.4, 0.4, 0.4) });
      pages.push(page);
    }
    pages.forEach((page, idx) => {
      packetPage++;
      const text = opts.stamp ? opts.stamp(item, idx + 1, pages.length, packetPage) : `D${item.n} p.${idx + 1}/${pages.length} - packet page ${packetPage}`;
      try {
        stampPage(page, text);
      } catch {
        // a page with an unusual box; the stamp is a courtesy
      }
    });
    appended.push({ n: item.n, documentId: item.documentId, title: item.title, pages: pages.length, startPage: pages.length ? startPage : null, how, error });
  }
  opts.onProgress?.(items.length, items.length);
  const bytes = Buffer.from(await out.save({ useObjectStreams: true }));
  return { bytes, pageCount: out.getPageCount(), appended };
}

/** Number of pages an original will occupy when appended, computed before the HTML is paginated. */
export async function appendixPageCount(item: Omit<AppendItem, 'n' | 'title' | 'documentId'>): Promise<number> {
  if (item.kind === 'pdf') {
    try {
      return await pdfPageCountOf(item.bytes);
    } catch {
      let n = 0;
      for (let p = 1; p <= 2000; p++) {
        try {
          renderDocumentPagePng(item.bytes, 'application/pdf', p, 0.1);
          n++;
        } catch {
          break;
        }
      }
      return Math.max(1, n);
    }
  }
  return imagePageCount(item.bytes, item.mime, item.pageCount);
}
