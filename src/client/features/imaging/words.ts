/**
 * Scans in plain words, for the Scans and imaging page and its pane. The stored
 * values stay as they are (MRI, XR, US, dicom, ...); only what is shown changes.
 */
import type { ImagingEntry } from '../../api/imaging';

/** The kind of scan, as a patient says it (the stored code stays MRI, CT, XR, US, ...). */
export const MODALITY_WORDS: Record<string, string> = {
  MRI: 'MRI',
  CT: 'CT',
  PET: 'PET',
  'PET-CT': 'PET-CT',
  'PET-MRI': 'PET-MRI',
  SPECT: 'SPECT',
  XR: 'X-ray',
  US: 'Ultrasound',
  EEG: 'EEG',
  EMG: 'EMG',
  NCS: 'Nerve conduction',
  other: 'Other',
};

/** A longer label for the Add a scan dialog, where a short code alone would be a riddle. */
export const MODALITY_LONG_WORDS: Record<string, string> = {
  ...MODALITY_WORDS,
  EEG: 'EEG (brain wave recording)',
  EMG: 'EMG (muscle and nerve test)',
  NCS: 'Nerve conduction study',
  SPECT: 'SPECT (nuclear scan)',
};

export function modalityWord(m: string | null | undefined): string {
  if (!m) return 'Scan';
  return MODALITY_WORDS[m] ?? m;
}

/** "3 image files", "images held", or null when there are none on file. */
export function imagesWords(e: Pick<ImagingEntry, 'dicomCount' | 'hasImages'>): string | null {
  if (e.dicomCount) return `${e.dicomCount} image file${e.dicomCount === 1 ? '' : 's'}`;
  if (e.hasImages) return 'images held';
  return null;
}

/** Where a scan came from, in a few plain words, for a key fact (the same words as Lab results). */
export function scanOriginWords(e: Pick<ImagingEntry, 'source' | 'factId' | 'factDeleted'>): string {
  if (e.factDeleted) return 'From a detail that was later deleted';
  if (e.source === 'fact') return 'Read by Claude from the report';
  if (e.factId) return 'Read by Claude, then copied into your scan list';
  // The words Medications and Lab results use for a row typed in by hand.
  return 'Entered by hand';
}

/** "1st", "2nd", "3rd", "4th", ... */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/**
 * Where a scan stands among the scans of its kind ("2nd of 3 MRI brain scans"); a scan set aside is not counted
 * ("Not counted among the MRI brain scans"). Null without a place in the series (not in the By scan type groups).
 */
export function serialWords(serial: number | null | undefined, ofCount: number | null | undefined, modality: string, bodyPart: string | null | undefined): string | null {
  if (serial == null || ofCount == null) return null;
  const kind = `${modalityWord(modality)}${bodyPart ? ` ${bodyPart.toLowerCase()}` : ''} scans`;
  if (!serial) return `Not counted among the ${kind}`;
  if (ofCount <= 1) return `The only ${kind.replace(/scans$/, 'scan')}`;
  return `${ordinal(serial)} of ${ofCount} ${kind}`;
}

/** A linked document's kind in words ("dicom" is a scan image file). */
export function fileKindWords(kind: string): string {
  if (kind === 'dicom') return 'scan image file';
  if (kind === 'pdf') return 'PDF';
  if (kind === 'image') return 'photo or scan';
  return 'document';
}

/** The page's one sentence of purpose (PageHeader intro). */
export const IMAGING_INTRO = 'MRI, CT, PET and other scans, each with what its report found. Each scan read from a report is checked against your clinical records, and any two reports can be compared word by word.';

/** "3 scans · 2 MRI · 1 CT": the kinds only when there is more than one, never a dangling "·"; null with no scans. */
export function scanCountWords(modalities: ReadonlyArray<{ modality: string; count: number }>): string | null {
  const total = modalities.reduce((n, x) => n + x.count, 0);
  if (!total) return null;
  const head = `${total} scan${total === 1 ? '' : 's'}`;
  const kinds = modalities.filter((x) => x.count > 0);
  return kinds.length > 1 ? [head, ...kinds.map((x) => `${x.count} ${modalityWord(x.modality)}`)].join(' · ') : head;
}
