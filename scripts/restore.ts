// Restore a backup zip into the data directory. Refuses to touch an existing
// case unless --force is given; then the old data directory is renamed to
// <data>.bak-<timestamp> first (never deleted). Stop the app before restoring.
// The zip is checked before anything is moved, and every restored file is
// checked against the zip's size and CRC-32 (src/server/files/unzip.ts).
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/server/config';
import { extractZip, listZipEntries } from '../src/server/files/unzip';

const zipArg = process.argv[2];
const force = process.argv.includes('--force');
if (!zipArg || !fs.existsSync(zipArg)) {
  console.error('usage: npm run restore -- <backup.zip> [--force]');
  process.exit(1);
}
const zipPath = path.resolve(zipArg);

let names: string[] = [];
try {
  names = listZipEntries(zipPath).map((e) => e.name);
} catch (err) {
  console.error(`${zipPath} cannot be read as a zip: ${err instanceof Error ? err.message : err}. Nothing was changed.`);
  process.exit(1);
}
if (!names.includes('keyring.json') || !names.includes('casefile.db')) {
  console.error(`${zipPath} is not a Casefile backup (it needs keyring.json and casefile.db). Nothing was changed.`);
  process.exit(1);
}

const hasData = fs.existsSync(path.join(config.dataDir, 'casefile.db')) || fs.existsSync(path.join(config.dataDir, 'keyring.json'));
if (hasData && !force) {
  console.error(`data directory ${config.dataDir} already contains a case. Re-run with --force to replace it (a .bak copy is kept).`);
  process.exit(1);
}
let bak: string | null = null;
if (hasData) {
  bak = `${config.dataDir}.bak-${Date.now()}`;
  fs.renameSync(config.dataDir, bak);
  console.log(`existing data moved to ${bak}`);
}
extractZip(zipPath, config.dataDir)
  .then((r) => {
    console.log(`restored ${r.files} files (${(r.bytes / 1024 / 1024).toFixed(1)} MB) into ${config.dataDir}. Start the app and unlock with the passphrase that was in use when the backup was made.`);
  })
  .catch((err) => {
    console.error('restore failed:', err instanceof Error ? err.message : err);
    if (bak) console.error(`the previous data is untouched in ${bak}; ${config.dataDir} holds a partial restore (rename it aside before trying again).`);
    process.exit(1);
  });
