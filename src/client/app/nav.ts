import type { PendingCounts } from '../api/filing';

export interface NavItem {
  to: string;
  label: string;
  /** Keyboard chord (still works; not shown in the menu). */
  chord: string; // "g d"
  group: string;
  /** One plain sentence: what this page is for (menu tooltip and page intro). */
  hint: string;
  /** Which waiting-for-you count this item shows in yellow. */
  pending?: keyof PendingCounts;
  /** How the count reads in the tooltip ("3 need a source"); default "waiting for you". */
  pendingWords?: string;
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Home', chord: 'g t', group: '', hint: 'What is waiting for you, what is coming up, and a place to add documents.' },
  { to: '/ask', label: 'Ask the clinician', chord: 'g a', group: '', hint: 'Ask questions about the whole case; answers cite the records they come from.' },
  { to: '/search', label: 'Search everything', chord: 'g /', group: '', hint: 'Find a word or name in every document, note and record.' },

  { to: '/documents', label: 'Documents', chord: 'g d', group: 'Your records', hint: 'Every file you have added. Claude reads, names and sorts each one.', pending: 'documents' },
  { to: '/labs', label: 'Lab results', chord: 'g b', group: 'Your records', hint: 'Every lab value, grouped by test (spinal fluid, blood counts, and so on).' },
  { to: '/imaging', label: 'Scans and imaging', chord: 'g i', group: 'Your records', hint: 'MRI, CT, PET and other scans with what each report found.' },
  { to: '/medications', label: 'Medications', chord: 'g m', group: 'Your records', hint: 'Current and past medications, allergies, and drugs that must never be given.' },
  { to: '/encounters', label: 'Appointments', chord: 'g e', group: 'Your records', hint: 'Past and upcoming visits, with questions to ask and what was decided.' },
  { to: '/communications', label: 'Calls and messages', chord: 'g c', group: 'Your records', hint: 'Phone calls, portal messages and letters, with any promised follow-ups.' },
  { to: '/symptoms', label: 'Symptom diary', chord: 'g s', group: 'Your records', hint: 'Day-by-day symptoms and how severe they were.' },
  { to: '/notes', label: 'My notes', chord: 'g j', group: 'Your records', hint: "Only your own notes and your chief of staff's, never a clinical record: what they say about each drug, symptom and event, and how it stands against your records." },
  { to: '/timeline', label: 'Timeline', chord: 'g l', group: 'Your records', hint: 'Everything in the case that has a date, in date order.' },

  { to: '/plan', label: 'Plan', chord: 'g v', group: 'Keeping track', hint: 'Your current plan, read from the document you add: an outline, a checklist and its timing.' },
  { to: '/reconcile', label: 'Reconciliation', chord: 'g q', group: 'Keeping track', hint: 'Where your records disagree. Upload the record that settles it; anything wrong is marked inaccurate.', pending: 'needsSource', pendingWords: 'need a source' },
  { to: '/inbox', label: 'Check before filing', chord: 'g u', group: 'Keeping track', hint: "Uploads you want to look at before they are filed, with Claude's suggestion. Files added anywhere else go straight to Documents.", pending: 'inbox' },
  { to: '/tasks', label: 'To-do list', chord: 'g k', group: 'Keeping track', hint: 'Things to do, call about or chase up, with due dates.' },
  { to: '/care-team', label: 'Care team', chord: 'g w', group: 'Keeping track', hint: 'Who could look after a flare: role, status, the flare test, and a source for every fact.' },
  { to: '/records', label: 'Records checklist', chord: 'g r', group: 'Keeping track', hint: 'Which records you have, which you asked for, and which seem to be missing.' },
  { to: '/findings', label: 'What Claude noticed', chord: 'g n', group: 'Keeping track', hint: 'Contradictions, gaps and patterns Claude found across the records.', pending: 'findings' },
  { to: '/facts', label: 'Details from documents', chord: 'g f', group: 'Keeping track', hint: 'Every detail Claude pulled out of the documents, each with the page it came from.' },
  { to: '/people', label: 'People and places', chord: 'g p', group: 'Keeping track', hint: 'Clinicians, hospitals and other contacts.' },

  { to: '/export', label: 'Make a packet', chord: 'g x', group: 'Tools', hint: 'Build a PDF packet of records to send to a clinician or bring to a visit.' },
  { to: '/import', label: 'Import calendar or spreadsheet', chord: 'g y', group: 'Tools', hint: 'Bring in appointments from a calendar file, or labs and calls from a spreadsheet.' },
  { to: '/settings', label: 'Settings', chord: 'g ,', group: 'Tools', hint: 'Appearance, people with access, the AI key, backups.' },
  { to: '/guide', label: 'How CaseFile works', chord: 'g h', group: 'Tools', hint: 'The words and buttons you will meet, in plain terms: labels, Reconciliation, findings, Undo and more.' },
  { to: '/ai-log', label: 'AI usage log', chord: 'g o', group: 'Tools', hint: 'Every request sent to Claude and what it cost.' },
];

export const NAV_GROUPS = ['', 'Your records', 'Keeping track', 'Tools'];

/** The menu entry for a path (page intros reuse its hint). */
export function navItemFor(path: string): NavItem | undefined {
  return NAV.find((n) => n.to === path);
}
