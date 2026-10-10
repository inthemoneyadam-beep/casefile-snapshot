/**
 * Settings in plain words: model names a person reads ("Claude Sonnet 5.5", never "claude-sonnet-5-5"), the
 * thinking-effort steps, roles, and the audit log's actions and kinds of things.
 */

/** "claude-sonnet-5-5" -> "Claude Sonnet 5.5"; "claude-haiku-4-5" -> "Claude Haiku 4.5"; anything else as it is. */
export function modelWords(id: string | null | undefined): string {
  if (!id) return '';
  const m = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(id.trim());
  if (!m) return id;
  return `Claude ${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2].replace(/-/g, '.')}`;
}

export const EFFORT_WORDS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Very high', max: 'Highest' };

export const ROLE_WORDS: Record<string, string> = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };

/** The audit log's actions (AUDIT_ACTIONS and the free-text ones the server writes), as a person says them. */
export const AUDIT_ACTION_WORDS: Record<string, string> = {
  login: 'Signed in',
  lock: 'Locked',
  setup: 'Case created',
  create: 'Added',
  update: 'Changed',
  delete: 'Deleted',
  purge: 'Erased for good',
  export: 'Packet made',
  settings: 'Settings changed',
  passphrase: 'Passphrase changed',
  user: 'People with access changed',
  ai: 'Claude request',
  quarantine: "May be someone else's record",
  mine: "It's mine",
  not_mine: 'Not my record',
};

export function auditActionWords(a: string): string {
  return AUDIT_ACTION_WORDS[a] ?? a.charAt(0).toUpperCase() + a.slice(1).replace(/[_.]/g, ' ');
}

/** What an audit row is about, by the stored kind of thing (a table name). */
export const AUDIT_ENTITY_WORDS: Record<string, string> = {
  documents: 'Document',
  document: 'Document',
  facts: 'Details',
  fact: 'Detail',
  lab_results: 'Lab values',
  medications: 'Medication',
  intolerances: 'Allergy',
  encounters: 'Appointment',
  communications: 'Call or message',
  people: 'Person or place',
  tasks: 'To-do',
  findings: 'What Claude noticed',
  records_inventory: 'Records checklist',
  imaging_studies: 'Scan',
  packets: 'Packet',
  settings: 'Settings',
  users: 'Person with access',
  user: 'Person with access',
  daily_logs: 'Symptom diary',
  symptom_entries: 'Symptom diary',
};

export function auditEntityWords(t: string | null | undefined): string {
  if (!t) return '';
  return AUDIT_ENTITY_WORDS[t] ?? t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, ' ');
}

/** The case's counts (system info) in words: "21 documents · 42 details". */
const COUNT_WORDS: Record<string, [string, string]> = {
  documents: ['document', 'documents'],
  facts: ['detail', 'details'],
  people: ['person or place', 'people and places'],
  communications: ['call or message', 'calls and messages'],
  records: ['record on the checklist', 'records on the checklist'],
  tasks: ['to-do', 'to-dos'],
  findings: ['notice from Claude', 'notices from Claude'],
};

export function countWords(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([k, n]) => {
      const w = COUNT_WORDS[k];
      return `${n} ${w ? (n === 1 ? w[0] : w[1]) : k.replace(/_/g, ' ')}`;
    })
    .join(' · ');
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Settings, Backups, in plain words. On a hosted server (Railway) the backups stay on the server's volume, so the
 * words say to download a copy now and then; a restore there starts from the first screen of an empty server.
 */
export const BACKUP_WORDS = {
  introLocal: 'A backup is one zip of the encrypted case and its files. It still needs a passphrase to open, and restoring one never overwrites the case you have now.',
  introHosted:
    'A backup is one zip of the encrypted case and its files. It still needs a passphrase to open. Backups made here stay on the server: download one now and then and keep it somewhere of your own, such as your computer or a USB stick.',
  restoreLocal: 'To restore one, start the app with an empty case folder and choose Restore from a backup on its first screen, or use npm run restore, which puts the current case aside first.',
  restoreHosted: 'A restore needs an empty server: the first screen of a new one (a new Railway volume) offers Restore from a backup. Restoring never overwrites a case.',
} as const;

/** The toast after Back up now: the file's name on a hosted server (its path means nothing there), else its path. */
export function backupSavedWords(r: { path: string; name?: string }, warnings: number, hosted: boolean): string {
  const where = hosted ? (r.name ?? r.path.split(/[\\/]/).pop() ?? r.path) : r.path;
  return warnings ? `Backup saved with ${warnings} warning${warnings === 1 ? '' : 's'}: ${where}` : `Backup saved: ${where}`;
}
