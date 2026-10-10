/**
 * The unlock screen's "The backup is restored" line: shown in the tab (or browser session) that was on the first
 * screen when the case was restored, until someone unlocks there once. The server's status keeps the restore's
 * outcome until it restarts, so without these two notes every later visitor would be told about an old restore.
 * Kept in this tab's sessionStorage when it can be (a reload keeps them), else for as long as the page is open.
 */
const SEEN_KEY = 'casefile.restoreNoticeSeen';
const SETUP_KEY = 'casefile.setupScreenShown';
let seen: string | null = null;
let setupShown = false;

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // the module copy is enough for this page
  }
}

/** The first screen (no case yet) was shown in this tab. */
export function noteSetupScreenShown(): void {
  if (setupShown) return;
  setupShown = true;
  write(SETUP_KEY, '1');
}

/** Whether to say the backup is restored: this tab was on the first screen, and has not unlocked since that restore. */
export function showRestoreNotice(at: string): boolean {
  const shown = setupShown || read(SETUP_KEY) === '1';
  if (!shown) return false;
  if (seen === at) return false;
  return read(SEEN_KEY) !== at;
}

export function markRestoreNoticeSeen(at: string): void {
  seen = at;
  write(SEEN_KEY, at);
}
