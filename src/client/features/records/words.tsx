/**
 * The Records checklist in plain words. The stored values stay as they are
 * (clinical_note, imaging_images, not_held, requested, ...); only what is shown
 * changes, and every list, filter, form and pane uses these same words.
 */
import { RECORD_FORMATS, RECORD_STATUSES, RECORD_TYPES } from '@shared/enums';
import { Tag, type TagTone } from '../../ui/StatusTag';

/** What kind of record, as a patient says it. */
export const RECORD_TYPE_WORDS: Record<string, string> = {
  clinical_note: 'Clinic note',
  lab: 'Lab report',
  imaging_report: 'Scan report',
  imaging_images: 'Scan images',
  dicom: 'Scan image files',
  pathology: 'Pathology report',
  operative_report: 'Procedure report',
  discharge_summary: 'Discharge summary',
  portal_thread: 'Portal messages',
  billing: 'Bills',
  genetic: 'Genetic test',
  other: 'Other',
};

/** Where a record stands, in the words of the Show: filter (Asked for, Have, Missing). */
export const RECORD_STATUS_WORDS: Record<string, string> = {
  unknown: 'not sure yet',
  expected: 'missing',
  requested: 'asked for',
  received: 'received',
  not_held: 'they have none',
  denied: 'refused',
};

const RECORD_STATUS_TITLE: Record<string, string> = {
  unknown: 'Not known yet whether this record exists or where it is',
  expected: 'The record should exist, but you do not have it and have not asked for it yet',
  requested: 'You asked for it and are waiting',
  received: 'You have it',
  not_held: 'The place you asked says it has no such record',
  denied: 'The place you asked refused to send it',
};

const RECORD_STATUS_TONE: Record<string, TagTone> = { unknown: 'neutral', expected: 'warn', requested: 'info', received: 'ok', not_held: 'ash', denied: 'danger' };

/** The form a record comes in. */
export const RECORD_FORMAT_WORDS: Record<string, string> = {
  report: 'A report',
  images: 'Images',
  dicom: 'Image files (DICOM)',
  raw: 'Raw data',
  unknown: 'Not known',
};

/** What your copy is (the same words, without "Not known"). */
export const HELD_FORM_WORDS: Record<string, string> = {
  report: 'A report',
  images: 'Images',
  dicom: 'Image files (DICOM)',
  raw: 'Raw data',
};

export function recordTypeWords(t: string | null | undefined): string {
  if (!t) return 'Other';
  return RECORD_TYPE_WORDS[t] ?? t.replace(/_/g, ' ');
}

export function recordStatusWords(s: string | null | undefined): string {
  if (!s) return RECORD_STATUS_WORDS.unknown;
  return RECORD_STATUS_WORDS[s] ?? s.replace(/_/g, ' ');
}

/** The record's status as a small tag in plain words ("asked for", "they have none"); the meaning on hover. */
export function RecordStatus({ status }: { status: string }) {
  return (
    <Tag tone={RECORD_STATUS_TONE[status] ?? 'neutral'} title={RECORD_STATUS_TITLE[status]}>
      {recordStatusWords(status)}
    </Tag>
  );
}

/** Choices for a select: stored value, plain words. */
export const RECORD_TYPE_OPTIONS = RECORD_TYPES.map((t) => ({ value: t, label: RECORD_TYPE_WORDS[t] ?? t }));
export const RECORD_STATUS_OPTIONS = RECORD_STATUSES.map((s) => ({ value: s, label: recordStatusWords(s).replace(/^./, (c) => c.toUpperCase()) }));
export const RECORD_FORMAT_OPTIONS = RECORD_FORMATS.map((f) => ({ value: f, label: RECORD_FORMAT_WORDS[f] ?? f }));

/** What your copy is, inside a sentence ("Yes: image files (DICOM)"). */
export const HELD_COPY_WORDS: Record<string, string> = { report: 'a report', images: 'images', dicom: 'image files (DICOM)', raw: 'raw data' };
