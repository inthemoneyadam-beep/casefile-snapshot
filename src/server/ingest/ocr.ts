/**
 * OCR worker pool over tesseract.js. The only OCR entry point (see
 * DECISIONS.md #2): a native engine can replace this module behind the same
 * interface. Workers start lazily, run fully offline from the bundled
 * language data, and terminate after an idle period or on process exit.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createWorker, type Worker } from 'tesseract.js';
import { config, projectRoot } from '../config';

export interface OcrWord {
  t: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  c: number;
}

export interface OcrResult {
  text: string;
  /** Mean word confidence, 0-100. */
  confidence: number;
  words: OcrWord[];
}

export const OCR_POOL_SIZE = Math.min(4, Math.max(1, Math.floor(os.cpus().length / 4)));
const IDLE_TERMINATE_MS = 90_000;
const LANG_PATH = path.join(projectRoot, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int');

interface Task {
  image: Buffer;
  signal?: AbortSignal;
  /** Give up on this image after this long; the worker that was reading it is replaced. */
  timeoutMs?: number;
  resolve: (r: OcrResult) => void;
  reject: (e: unknown) => void;
}

/** Per-image limit used by page-by-page OCR of large documents (a stuck page never holds the rest). */
export const OCR_PAGE_TIMEOUT_MS = 120_000;

const workers: Worker[] = [];
const idle: Worker[] = [];
const queue: Task[] = [];
let starting = 0;
let idleTimer: NodeJS.Timeout | null = null;
let hooked = false;

function abortError(): Error {
  const e = new Error('OCR cancelled');
  e.name = 'AbortError';
  return e;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /cancelled|aborted/i.test(err.message));
}

/** The error an image gets when it took longer than its time limit. */
export class OcrTimeoutError extends Error {
  constructor(ms: number) {
    super(`reading the image took longer than ${Math.round(ms / 1000)} seconds`);
    this.name = 'OcrTimeoutError';
  }
}

/**
 * Recognise one image (PNG/JPEG/BMP/WebP bytes). Boxes are in image pixels. With `timeoutMs`, an image that takes
 * longer is rejected with OcrTimeoutError and the worker reading it is stopped and replaced; the queue goes on.
 */
export function ocrImage(image: Buffer, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<OcrResult> {
  return new Promise<OcrResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }
    queue.push({ image, signal: opts.signal, timeoutMs: opts.timeoutMs, resolve, reject });
    pump();
  });
}

function pump(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  while (queue.length && idle.length) {
    const w = idle.pop()!;
    const t = queue.shift()!;
    void runTask(w, t);
  }
  if (queue.length && workers.length + starting < OCR_POOL_SIZE) {
    starting++;
    void spawn();
  }
  if (!queue.length && workers.length && idle.length === workers.length) {
    idleTimer = setTimeout(() => void terminateOcr(), IDLE_TERMINATE_MS);
    idleTimer.unref?.();
  }
}

async function spawn(): Promise<void> {
  try {
    fs.mkdirSync(config.tessCacheDir, { recursive: true });
    const w = await createWorker('eng', 1, {
      langPath: LANG_PATH,
      cachePath: config.tessCacheDir,
      gzip: true,
      logger: () => {},
      errorHandler: () => {},
    });
    workers.push(w);
    idle.push(w);
    hookExit();
  } catch (err) {
    // Could not start a worker. If nothing else can serve the queue, fail it.
    if (!workers.length && starting <= 1) {
      const pending = queue.splice(0, queue.length);
      for (const t of pending) t.reject(err instanceof Error ? err : new Error(String(err)));
    }
  } finally {
    starting--;
    pump();
  }
}

async function runTask(w: Worker, t: Task): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;
  try {
    if (t.signal?.aborted) {
      t.reject(abortError());
      return;
    }
    const work = w.recognize(t.image, {}, { blocks: true, text: true });
    const limit = t.timeoutMs && t.timeoutMs > 0 ? t.timeoutMs : 0;
    const { data } = limit
      ? await Promise.race([
          work,
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => {
              timedOut = true;
              work.catch(() => undefined);
              rej(new OcrTimeoutError(limit));
            }, limit);
            timer.unref?.();
          }),
        ])
      : await work;
    const words: OcrWord[] = [];
    let sum = 0;
    for (const b of data.blocks ?? []) {
      for (const p of b.paragraphs ?? []) {
        for (const l of p.lines ?? []) {
          for (const word of l.words ?? []) {
            const text = (word.text ?? '').trim();
            if (!text) continue;
            const c = Math.round(Number(word.confidence) || 0);
            sum += c;
            words.push({ t: text, x0: word.bbox.x0, y0: word.bbox.y0, x1: word.bbox.x1, y1: word.bbox.y1, c });
          }
        }
      }
    }
    const confidence = words.length ? Math.round((sum / words.length) * 10) / 10 : Math.round(Number(data.confidence) || 0);
    t.resolve({ text: (data.text ?? '').replace(/\r\n?/g, '\n').trimEnd(), confidence, words });
  } catch (err) {
    t.reject(err);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) retire(w);
    else if (workers.includes(w)) idle.push(w);
    pump();
  }
}

/** Stops a worker that is stuck on an image; pump() starts a fresh one for the rest of the queue. */
function retire(w: Worker): void {
  const i = workers.indexOf(w);
  if (i >= 0) workers.splice(i, 1);
  const j = idle.indexOf(w);
  if (j >= 0) idle.splice(j, 1);
  void w.terminate().catch(() => undefined);
}

/** Stop every worker. Safe to call repeatedly. */
export async function terminateOcr(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const ws = workers.splice(0, workers.length);
  idle.splice(0, idle.length);
  await Promise.allSettled(ws.map((w) => w.terminate()));
}

function hookExit(): void {
  if (hooked) return;
  hooked = true;
  process.once('exit', () => {
    for (const w of workers) void w.terminate().catch(() => {});
  });
}
