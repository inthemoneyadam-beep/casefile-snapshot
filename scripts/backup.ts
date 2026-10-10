// One-command backup: zips the encrypted database, keyring, and file store
// into a new file (an existing backup is never overwritten). Consistent when
// the app is stopped or locked; while the app has the case unlocked it warns
// and Back up now in Settings is the consistent way (see services/backup.ts).
import { createBackupZip } from '../src/server/services/backup';

const dest = process.argv[2];
createBackupZip(dest)
  .then((r) => {
    console.log(`backup written: ${r.path} (${(r.bytes / 1024 / 1024).toFixed(1)} MB)`);
    for (const w of r.warnings) console.warn(`warning: ${w}`);
  })
  .catch((err) => {
    console.error('backup failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
