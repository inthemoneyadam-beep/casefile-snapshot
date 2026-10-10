/**
 * Check before filing (the inbox), in plain words (2026-10 UI overhaul). The page was "Unsorted uploads", a name that
 * clashed with the Documents page's "not sorted yet" (documents Claude has not named and filed): this page holds only
 * the uploads you chose to look at before they are filed. The name lives here once, so the page, its commands, its
 * dialogs and its notices say the same thing (the menu entry is in app/nav.ts).
 *
 * Plain TypeScript (no components, no DOM) so tests can import it directly.
 */
import type { TriageAction } from '@shared/schemas/inbox';

export const INBOX_NAME = 'Check before filing';

/** What filing will do, one line per choice (never the stored action name). */
export const ACTION_WORDS: Record<TriageAction, string> = {
  extract_facts: 'Pull out the details (Claude reads it)',
  create_inventory_row: 'Add it to the Records checklist as a record you have',
  link_encounter: 'Link it to an appointment',
  create_person: 'Add the new people named above',
  mark_record_received: 'Mark records you were waiting for as received',
  create_communication: 'Add it to Calls and messages (this document is the message)',
};

/** What the document holds, as Claude read it. */
export const CONTAINS_WORDS: Record<string, string> = {
  labs: 'lab results',
  imaging: 'scans',
  medications: 'medications',
  plan_or_recommendations: 'a plan or recommendations',
  portal_thread: 'a portal thread',
  transcript: 'a call transcript',
};

/** How sure Claude is about where it goes, in words (the number on hover). */
export function sureWords(confidence: number): string {
  if (confidence >= 0.85) return 'Sure';
  if (confidence >= 0.6) return 'Fairly sure';
  return 'Not sure; check it';
}

/** Who wrote it (stored author role), in words. */
export const AUTHOR_ROLE_WORDS: Record<string, string> = {
  clinician: 'A clinician',
  patient: 'You',
  chief_of_staff: 'Chief of staff',
  ai_summary: 'Claude (a summary)',
  advocate: 'An advocate',
  other: 'Someone else',
};

/** The kind of file (stored `kind`), in words. */
export const FILE_KIND_WORDS: Record<string, string> = {
  pdf: 'PDF',
  image: 'Picture',
  docx: 'Word document',
  text: 'Text',
  csv: 'Spreadsheet (CSV)',
  json: 'Data file',
  dicom: 'Scan images (DICOM)',
  audio_transcript: 'Call transcript',
  other: 'Other',
};

/** What filing did, as the parts of one sentence ("2 new people", "linked to an appointment"). */
export function filedParts(f: {
  createdPersonIds: string[];
  encounterId: string | null;
  receivedInventoryRowIds: string[];
  inventoryRowId: string | null;
  communicationId: string | null;
  extractionQueued: boolean;
  warnings: string[];
}): string[] {
  const bits: string[] = [];
  if (f.createdPersonIds.length) bits.push(`${f.createdPersonIds.length} new ${f.createdPersonIds.length === 1 ? 'person' : 'people'}`);
  if (f.encounterId) bits.push('linked to an appointment');
  if (f.receivedInventoryRowIds.length) bits.push(`${f.receivedInventoryRowIds.length} awaited record${f.receivedInventoryRowIds.length === 1 ? '' : 's'} marked received`);
  if (f.inventoryRowId && !f.receivedInventoryRowIds.includes(f.inventoryRowId)) bits.push('added to the Records checklist');
  if (f.communicationId) bits.push('added to Calls and messages');
  if (f.extractionQueued) bits.push('Claude will pull out the details');
  if (f.warnings.length) bits.push(`${f.warnings.length} warning${f.warnings.length === 1 ? '' : 's'}`);
  return bits;
}

/** The fields filing set on the document, in words. */
export const FIELD_WORDS: Record<string, string> = {
  title: 'title',
  category: 'type',
  sourceTier: 'kind of document',
  documentDateText: 'date',
  institutionId: 'institution',
  newInstitutionName: 'institution',
  authorPersonId: 'author',
  newAuthorName: 'author',
};
