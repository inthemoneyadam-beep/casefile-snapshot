/**
 * /api/import — calendar and spreadsheet import (docs/API-CONTRACTS-3.md, slice O).
 *
 *   GET  /status          { icsImported }: how many calendar events are recorded as imported
 *   POST /ics             one .ics (multipart field `file`, or the raw text/calendar body)
 *                         -> a preview of every event with a suggestion; writes nothing
 *   POST /ics/apply       JSON { filename?, items: [{ uid, kind, clinicianId?, institutionId?,
 *                         title?, encounterKind?, start?, time?, summary?, location?, description? }] }
 *                         -> { imported, encounters, daily, created, skipped }; idempotent by UID
 *   POST /csv?dryRun=1    one .csv (multipart `file`) with `target` = symptoms | labs | communications
 *                         and the optional `exclude` (row numbers), `createPeople` (1) and `map`
 *                         (JSON { name: personId | "new" | "none" }), as form fields or query
 *                         parameters -> { imported, skipped: { row, reason }[], ... }
 *
 * Uploads are read in memory and never stored: the import keeps what it
 * writes (encounters, notes, rows) and names the file in each one's notes.
 * Text is decoded as UTF-8 (a BOM dropped), UTF-16 with a BOM, or, when the
 * bytes are not valid UTF-8, Windows-1252 (what Excel on Windows writes).
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { badRequest, HttpError } from '../util/errors';
import { applyCalendar, importedUids, previewCalendar } from '../services/import-calendar';
import { importCsvFile, MAX_CSV_ROWS } from '../services/import-csv';

/** The largest file an import reads. */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

function decodeWith(encoding: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return null;
  }
}

/** The text of an uploaded file; see the file header for the encodings tried. */
export function decodeText(buf: Uint8Array): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return decodeWith('utf-16le', buf.subarray(2)) ?? '';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return decodeWith('utf-16be', buf.subarray(2)) ?? '';
  const body = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return decodeWith('windows-1252', body) ?? Buffer.from(body).toString('latin1');
  }
}

interface Upload {
  text: string;
  filename: string | null;
  /** Every other form field (or JSON property). */
  fields: Record<string, unknown>;
}

const TEXT_FIELDS = new Set(['text', 'csv', 'ics']);

function tooLarge(name: string | null): HttpError {
  return new HttpError(413, `${name ? `"${name}"` : 'the file'} is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB; split it and import the parts`);
}

async function readUpload(c: Context, what: string): Promise<Upload> {
  const ct = c.req.header('content-type') ?? '';
  const fields: Record<string, unknown> = {};
  let text: string | null = null;
  let filename: string | null = null;
  if (/multipart\/form-data|application\/x-www-form-urlencoded/i.test(ct)) {
    const form = await c.req.parseBody({ all: true });
    for (const [key, value] of Object.entries(form)) {
      const list = Array.isArray(value) ? value : [value];
      for (const item of list) {
        if (typeof item === 'string') {
          if (TEXT_FIELDS.has(key) && text === null) text = item;
          else fields[key] = item;
        } else if (item && text === null) {
          if (item.size > MAX_IMPORT_BYTES) throw tooLarge(item.name || null);
          text = decodeText(new Uint8Array(await item.arrayBuffer()));
          filename = item.name || null;
        }
      }
    }
  } else if (/application\/json/i.test(ct)) {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest(`send the ${what} file as a "file" form field`);
    for (const [key, value] of Object.entries(body)) {
      if (TEXT_FIELDS.has(key) && typeof value === 'string' && text === null) text = value;
      else fields[key] = value;
    }
  } else {
    const buf = new Uint8Array(await c.req.arrayBuffer());
    if (buf.length > MAX_IMPORT_BYTES) throw tooLarge(null);
    text = decodeText(buf);
  }
  if (!text || !text.trim()) throw badRequest(`send the ${what} file as a "file" form field`);
  const named = typeof fields.filename === 'string' ? fields.filename : c.req.query('filename');
  return { text, filename: (filename ?? named ?? '').trim().slice(0, 300) || null, fields };
}

/** A field, else the query parameter of the same name. */
function option(up: Upload, c: Context, name: string): unknown {
  const v = up.fields[name];
  return v !== undefined ? v : c.req.query(name);
}

function isOn(v: unknown): boolean {
  return v === true || v === 1 || (typeof v === 'string' && /^(1|true|yes|on)$/i.test(v.trim()));
}

/** Row numbers: a JSON array, or numbers separated by commas or spaces. */
export function rowList(v: unknown): number[] {
  let list: unknown[] = [];
  if (Array.isArray(v)) list = v;
  else if (typeof v === 'string' && v.trim()) {
    const t = v.trim();
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t) as unknown;
        list = Array.isArray(parsed) ? parsed : [];
      } catch {
        throw badRequest('exclude must be row numbers: 3,7,12 or [3,7,12]');
      }
    } else list = t.split(/[\s,;]+/);
  } else if (typeof v === 'number') list = [v];
  const out: number[] = [];
  for (const x of list) {
    const n = typeof x === 'number' ? x : Number(String(x).trim());
    if (!Number.isInteger(n) || n < 1) throw badRequest(`exclude: "${String(x)}" is not a row number`);
    out.push(n);
  }
  if (out.length > MAX_CSV_ROWS) throw badRequest(`exclude lists more than ${MAX_CSV_ROWS} rows`);
  return out;
}

const decisionMap = z.record(z.string().max(300), z.string().trim().min(1).max(64)).refine((m) => Object.keys(m).length <= 5000, 'map has more than 5000 names');

/** The per-name decisions for a communications import: a JSON object of name -> person id, "new" or "none". */
export function nameMap(v: unknown): Record<string, string> {
  if (v === undefined || v === null || v === '') return {};
  let raw: unknown = v;
  if (typeof v === 'string') {
    try {
      raw = JSON.parse(v);
    } catch {
      throw badRequest('map must be a JSON object of name -> person id, "new" or "none"');
    }
  }
  const r = decisionMap.safeParse(raw);
  if (!r.success) throw badRequest(`map: ${r.error.issues.map((i) => i.message).join('; ')}`);
  return r.data;
}

export const importRoutes = new Hono()
  .get('/status', (c) => c.json({ icsImported: importedUids().length }))

  // Calendar ------------------------------------------------------------------
  .post('/ics', async (c) => {
    const up = await readUpload(c, 'calendar (.ics)');
    const tz = option(up, c, 'timeZone');
    return c.json(previewCalendar(up.text, { filename: up.filename, timeZone: typeof tz === 'string' && tz.trim() ? tz.trim() : null }));
  })
  .post('/ics/apply', async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as unknown;
    if (body === undefined) throw badRequest('send JSON { items: [{ uid, kind }] }');
    return c.json(applyCalendar(body));
  })

  // Spreadsheets --------------------------------------------------------------
  .post('/csv', async (c) => {
    const up = await readUpload(c, 'spreadsheet (.csv)');
    const target = option(up, c, 'target');
    if (typeof target !== 'string' || !target.trim()) throw badRequest('target is required: symptoms, labs or communications');
    return c.json(
      importCsvFile(target.trim(), up.text, {
        filename: up.filename,
        dryRun: isOn(option(up, c, 'dryRun')),
        exclude: rowList(option(up, c, 'exclude')),
        createPeople: isOn(option(up, c, 'createPeople')),
        map: nameMap(option(up, c, 'map')),
      }),
    );
  });
