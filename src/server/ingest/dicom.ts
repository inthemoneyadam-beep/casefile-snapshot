/**
 * DICOM metadata (no pixel decoding; that is the Phase 4 viewer). Common tags
 * become `metadataJson.dicom` and one text page of `Tag: value` lines so the
 * study is searchable and citable.
 */
import * as dicomNs from 'dicom-parser';
import { parsePartialDate, type PartialDate } from '../../shared/dates';

// dicom-parser ships a UMD build; under Node ESM the API lives on `default`.
const dicomParser = ((dicomNs as unknown as { default?: typeof dicomNs }).default ?? dicomNs) as typeof dicomNs;

export interface DicomMeta {
  patientName?: string;
  patientId?: string;
  patientBirthDate?: string;
  patientSex?: string;
  studyDate?: string;
  studyTime?: string;
  seriesDate?: string;
  modality?: string;
  studyDescription?: string;
  seriesDescription?: string;
  institutionName?: string;
  referringPhysician?: string;
  bodyPartExamined?: string;
  manufacturer?: string;
  rows?: number;
  columns?: number;
  numberOfFrames?: number;
  sopInstanceUid?: string;
  studyInstanceUid?: string;
  seriesInstanceUid?: string;
  transferSyntaxUid?: string;
  accessionNumber?: string;
}

const STRING_TAGS: Array<[keyof DicomMeta, string, string]> = [
  ['patientName', 'x00100010', 'Patient name'],
  ['patientId', 'x00100020', 'Patient ID'],
  ['patientBirthDate', 'x00100030', 'Patient birth date'],
  ['patientSex', 'x00100040', 'Patient sex'],
  ['studyDate', 'x00080020', 'Study date'],
  ['studyTime', 'x00080030', 'Study time'],
  ['seriesDate', 'x00080021', 'Series date'],
  ['modality', 'x00080060', 'Modality'],
  ['studyDescription', 'x00081030', 'Study description'],
  ['seriesDescription', 'x0008103e', 'Series description'],
  ['institutionName', 'x00080080', 'Institution'],
  ['referringPhysician', 'x00080090', 'Referring physician'],
  ['bodyPartExamined', 'x00180015', 'Body part examined'],
  ['manufacturer', 'x00080070', 'Manufacturer'],
  ['accessionNumber', 'x00080050', 'Accession number'],
  ['sopInstanceUid', 'x00080018', 'SOP instance UID'],
  ['studyInstanceUid', 'x0020000d', 'Study instance UID'],
  ['seriesInstanceUid', 'x0020000e', 'Series instance UID'],
  ['transferSyntaxUid', 'x00020010', 'Transfer syntax UID'],
];

const LABELS: Record<string, string> = Object.fromEntries(STRING_TAGS.map(([k, , label]) => [k, label]));
LABELS.rows = 'Rows';
LABELS.columns = 'Columns';
LABELS.numberOfFrames = 'Number of frames';

function clean(s: string | undefined): string | undefined {
  const t = (s ?? '').replace(/\0/g, '').trim();
  return t ? t : undefined;
}

/** DICOM DA value YYYYMMDD -> partial date. */
export function dicomDate(da: string | undefined): PartialDate | null {
  const t = clean(da);
  if (!t) return null;
  const m = t.match(/^(\d{4})(\d{2})?(\d{2})?/);
  if (!m) return null;
  const iso = m[3] ? `${m[1]}-${m[2]}-${m[3]}` : m[2] ? `${m[1]}-${m[2]}` : m[1];
  const p = parsePartialDate(iso);
  return p.iso ? { ...p, text: t } : null;
}

export function parseDicomMeta(buffer: Buffer): { meta: DicomMeta; text: string; studyDate: PartialDate | null; warnings: string[] } {
  const ds = dicomParser.parseDicom(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), { untilTag: 'x7fe00010' });
  const meta: DicomMeta = {};
  for (const [key, tag] of STRING_TAGS) {
    const v = clean(ds.string(tag));
    if (v !== undefined) (meta as Record<string, string | number>)[key] = key === 'patientName' ? v.replace(/\^+/g, ' ').trim() : v;
  }
  const rows = ds.uint16('x00280010');
  const cols = ds.uint16('x00280011');
  const frames = ds.intString('x00280008');
  if (rows !== undefined) meta.rows = rows;
  if (cols !== undefined) meta.columns = cols;
  if (frames !== undefined && !Number.isNaN(frames)) meta.numberOfFrames = frames;

  const lines: string[] = [];
  for (const key of Object.keys(LABELS)) {
    const v = (meta as Record<string, string | number | undefined>)[key];
    if (v === undefined) continue;
    lines.push(`${LABELS[key]}: ${v}`);
  }
  const elementCount = Object.keys(ds.elements ?? {}).length;
  lines.push('', `DICOM elements read: ${elementCount}`);
  return { meta, text: lines.join('\n'), studyDate: dicomDate(meta.studyDate) ?? dicomDate(meta.seriesDate), warnings: ds.warnings ?? [] };
}
