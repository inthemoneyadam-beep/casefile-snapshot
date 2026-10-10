/**
 * /api/dicom — the DICOM viewer (slice N). Read-only: every route is a GET,
 * so every role may use it. Mounted by the integrator at /api/dicom.
 *
 *   GET /studies?q=                          studies grouped by StudyInstanceUID, with series, counts and linked records
 *   GET /series/:seriesUid                   one series, instances by InstanceNumber (then file name)
 *   GET /instances/:documentId               one instance: index, decodability, default window, value range
 *   GET /instances/:documentId/tags          every element with its dictionary name
 *   GET /instances/:documentId/frame/:n.png  frame n (1-based) as a PNG, ?wc=&ww=&scale=
 *
 * A compressed transfer syntax (JPEG, JPEG-LS, JPEG 2000, RLE, video) or a
 * pixel layout this build does not decode answers 415 with the syntax name;
 * the original stays downloadable from /api/documents/:id/file?download=1.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { badRequest, zodIssues } from '../util/errors';
import { DicomUnsupportedError, getDicomInstance, getDicomSeries, getDicomTags, listDicomStudies, renderDicomFrame } from '../services/dicom';

/** Decoded pixels are never cached by the browser (its disk cache would keep them after a lock); the server keeps its own LRU, cleared on lock. */
const IMAGE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
};

const idParam = z.string().trim().min(1).max(128);
const seriesParam = z.string().trim().min(1).max(200);
const studiesQuery = z.object({ q: z.string().trim().max(200).optional() });
const frameQuery = z.object({
  wc: z.coerce.number().finite().min(-1e7).max(1e7).optional(),
  ww: z.coerce.number().finite().gt(0).max(1e7).optional(),
  scale: z.coerce.number().finite().min(0.05).max(4).optional(),
});

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw badRequest(zodIssues(r.error, 'value'));
  return r.data;
}

function cleanQuery(q: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) if (v !== '') out[k] = v;
  return out;
}

function asBody(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** 415 with what the client needs to say why and offer the original instead. */
function unsupported(c: Context, err: DicomUnsupportedError, documentId: string) {
  return c.json({ error: err.message, reason: err.reason, transferSyntaxUid: err.transferSyntaxUid, transferSyntaxName: err.transferSyntaxName, documentId, download: `/api/documents/${encodeURIComponent(documentId)}/file?download=1` }, 415);
}

export const dicomRoutes = new Hono()
  .get('/studies', (c) => {
    const q = parse(studiesQuery, cleanQuery(c.req.query()));
    return c.json(listDicomStudies({ q: q.q }));
  })
  .get('/series/:seriesUid', (c) => {
    const key = parse(seriesParam, c.req.param('seriesUid'));
    return c.json(getDicomSeries(key));
  })
  .get('/instances/:documentId/tags', (c) => {
    const id = parse(idParam, c.req.param('documentId'));
    const items = getDicomTags(id);
    return c.json({ items, total: items.length });
  })
  .get('/instances/:documentId/frame/:file', (c) => {
    const id = parse(idParam, c.req.param('documentId'));
    const m = /^(\d{1,6})(?:\.png)?$/.exec(c.req.param('file'));
    if (!m) throw badRequest('frame must be a number, as in /frame/1.png');
    const n = Number(m[1]);
    if (n < 1) throw badRequest('frames are numbered from 1');
    const q = parse(frameQuery, cleanQuery(c.req.query()));
    try {
      const r = renderDicomFrame(id, n, q);
      return c.body(asBody(r.png), 200, {
        ...IMAGE_HEADERS,
        'content-type': 'image/png',
        'content-length': String(r.png.length),
        'x-dicom-window': r.window.source,
        'x-dicom-wc': String(r.window.center),
        'x-dicom-ww': String(r.window.width),
        'x-dicom-frames': String(r.frames),
        'x-dicom-size': `${r.width}x${r.height}`,
        ...(r.range ? { 'x-dicom-min': String(r.range.min), 'x-dicom-max': String(r.range.max) } : {}),
      });
    } catch (err) {
      if (err instanceof DicomUnsupportedError) return unsupported(c, err, id);
      throw err;
    }
  })
  .get('/instances/:documentId', (c) => {
    const id = parse(idParam, c.req.param('documentId'));
    return c.json(getDicomInstance(id));
  });
