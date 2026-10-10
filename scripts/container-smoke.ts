/**
 * Image build smoke test (Dockerfile; runs on any machine too: `node --import tsx scripts/container-smoke.ts`).
 * Proves, before Railway ever starts the image, that the hosted server works on this system: tsx runs the server
 * code, the encrypted SQLite binding loads and migrates, the setup code is required, the session cookie is the
 * hosted one, the built client is served under its Content-Security-Policy, a backup zip is written and listed,
 * MuPDF's WebAssembly loads. Chromium printing a PDF is tried too; a failure there is reported but does not fail
 * the build (packets then fall back to HTML, and the startup log says which browser was found).
 *
 * Everything happens in a fresh folder under the system temp folder, removed at the end; no Railway variable is
 * read and the volume is never touched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'casefile-smoke-'));
for (const k of Object.keys(process.env)) if (k.startsWith('RAILWAY_')) delete process.env[k];
process.env.CASEFILE_HOSTED = '1';
process.env.CASEFILE_DATA_DIR = path.join(root, 'case');
process.env.CASEFILE_BACKUPS_DIR = path.join(root, 'backups');
process.env.CASEFILE_SETUP_TOKEN = 'smoke-setup-code-1234';
process.env.LOG_LEVEL ??= 'warn';

const PASS = 'smoke test passphrase';

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`smoke: ${what}`);
  console.log(`smoke ok: ${what}`);
}

async function main(): Promise<void> {
  const { buildApp } = await import('../src/server/app');
  const { ensureDirs, config } = await import('../src/server/config');
  const { lock } = await import('../src/server/auth');
  ensureDirs();
  const app = buildApp();
  const headers = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };

  const health = await app.request('/healthz');
  const hj = (await health.json()) as { ok: boolean; locked: boolean; version: string };
  check(health.status === 200 && hj.ok && hj.locked, `GET /healthz answers (version ${hj.version})`);

  const page = await app.request('/');
  if (fs.existsSync(path.join(config.distDir, 'index.html'))) {
    const csp = page.headers.get('content-security-policy') ?? '';
    check(page.status === 200 && csp.includes("script-src 'self' 'sha256-") && page.headers.get('x-frame-options') === 'DENY', 'the built client is served with its Content-Security-Policy and frame refusal');
  } else console.log('smoke: no built client (dist/index.html); the page check is skipped');

  const noCode = await app.request('/api/auth/setup', { method: 'POST', headers, body: JSON.stringify({ passphrase: PASS }) });
  check(noCode.status === 401, 'setup without the setup code is refused');

  const setup = await app.request('/api/auth/setup', { method: 'POST', headers: { ...headers, 'x-casefile-setup-token': process.env.CASEFILE_SETUP_TOKEN! }, body: JSON.stringify({ passphrase: PASS, name: 'Smoke' }) });
  const setCookie = setup.headers.get('set-cookie') ?? '';
  check(setup.status === 200 && setCookie.startsWith('__Host-casefile_session=') && /;\s*Secure/i.test(setCookie), 'setup with the code opens an encrypted case and sets the Secure __Host- cookie');
  const cookie = setCookie.split(';')[0];

  const info = await app.request('/api/system/info', { headers: { cookie } });
  check(info.status === 200, 'the encrypted database answers behind the lock');

  const backup = await app.request('/api/system/backup', { method: 'POST', headers: { ...headers, cookie } });
  const bj = (await backup.json()) as { name?: string };
  const list = await app.request('/api/system/backups', { headers: { cookie } });
  const lj = (await list.json()) as { items: Array<{ name: string }> };
  check(backup.status === 200 && lj.items.some((i) => i.name === bj.name), 'Back up now writes a zip and Settings lists it');

  const mupdf = await import('mupdf');
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const doc = mupdf.Document.openDocument(Buffer.from(await pdf.save()), 'application/pdf');
  check(doc.countPages() === 1, 'MuPDF (WebAssembly) opens a PDF');
  doc.destroy();

  lock();

  const { findBrowserExecutable, htmlToPdfWithBrowser } = await import('../src/server/export/pdf');
  const exe = findBrowserExecutable();
  if (!exe) console.log('smoke WARNING: no Chromium found; packets would be stored as HTML');
  else {
    try {
      const out = await htmlToPdfWithBrowser('<!doctype html><p>smoke</p>', { executablePath: exe, timeoutMs: 60_000 });
      check(out.subarray(0, 4).toString() === '%PDF', `Chromium (${exe}) prints a PDF`);
    } catch (err) {
      console.log(`smoke WARNING: Chromium (${exe}) could not print here: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  }
}

main()
  .then(() => {
    console.log('container smoke: all checks passed');
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(1);
  });
