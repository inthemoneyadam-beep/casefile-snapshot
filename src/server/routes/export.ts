/**
 * /api/export — packets: build one from a config, list and inspect them,
 * fetch the stored PDF/HTML, soft-delete, and preview the HTML without
 * generating anything.
 */
import { Hono } from 'hono';
import { badRequest } from '../util/errors';
import { createPacket, deletePacket, exportOptions, getPacket, getPacketFile, listPackets, previewPacketHtml } from '../export/packet';

async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Packet files get the same headers as document originals (routes/documents.ts
 * fileResponseHeaders): never cached, since the browser's disk cache would keep
 * the plaintext packet after the case is locked, and anything that is not a PDF
 * (the HTML fallback) runs under the sandboxed, script-free file policy. PDFs
 * stay without the CSP because the browsers' built-in viewers refuse to run in
 * a sandboxed document; served as application/pdf with nosniff they cannot run
 * script on the origin.
 */
const FILE_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";

export function packetFileHeaders(mime: string, filename: string, download: boolean, length: number): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': mime,
    'content-length': String(length),
    'content-disposition': contentDisposition(download ? 'attachment' : 'inline', filename),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if ((mime || '').toLowerCase().split(';')[0].trim() !== 'application/pdf') headers['content-security-policy'] = FILE_CSP;
  return headers;
}

function asBody(buf: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}

/** `?config=<json>` for GET previews (the builder's "open in a new tab" link). */
function configFromQuery(raw: string | undefined): unknown {
  if (!raw) throw badRequest('config query parameter is required (JSON)');
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest('config must be JSON');
  }
}

export const exportRoutes = new Hono()
  .get('/', (c) => c.json({ items: listPackets() }))
  .get('/options', (c) => c.json(exportOptions()))
  .get('/preview', (c) => c.html(previewPacketHtml(configFromQuery(c.req.query('config')))))
  .post('/preview', async (c) => c.html(previewPacketHtml(await jsonBody(c))))
  .get('/packets', (c) => c.json({ items: listPackets() }))
  .post('/packets', async (c) => {
    const r = createPacket(await jsonBody(c));
    return c.json(r, 202);
  })
  .get('/packets/:id', (c) => c.json(getPacket(c.req.param('id'))))
  .get('/packets/:id/file', (c) => {
    const { bytes, mime, filename } = getPacketFile(c.req.param('id'));
    const download = c.req.query('download') === '1';
    return c.body(asBody(bytes), 200, packetFileHeaders(mime, filename, download, bytes.length));
  })
  .delete('/packets/:id', (c) => c.json(deletePacket(c.req.param('id'))));
