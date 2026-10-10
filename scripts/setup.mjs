// First-run setup: creates config.json and the data directories. Safe to re-run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'config.json');
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, JSON.stringify({ port: 4810, dataDir: 'data', backupsDir: 'backups' }, null, 2) + '\n');
  console.log('wrote config.json');
}
for (const d of ['data', 'data/files', 'data/tesscache', 'data/logs', 'backups']) {
  fs.mkdirSync(path.join(root, d), { recursive: true });
}
const tess = path.join(root, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz');
console.log(fs.existsSync(tess) ? 'OCR language data present (offline)' : 'WARNING: OCR language data missing; run npm install');
console.log('');
console.log('Casefile is ready. Start it with:  npm run dev   (development)   or   npm start   (production build)');
console.log('Then open http://127.0.0.1:4811 (dev) or http://127.0.0.1:4810 (production) and create your passphrase.');
