/**
 * DICOM viewer service (slice N): series grouping, tag listing and server-side
 * pixel decoding to PNG.
 *
 * - Grouping. Documents of kind `dicom` are grouped by StudyInstanceUID and
 *   SeriesInstanceUID. Ingestion stores a subset of tags in
 *   `metadataJson.dicom`; the viewer needs a few more (InstanceNumber, bit
 *   depth, rescale, window, spacing), so the first time a file is read here
 *   its index is written beside it as `metadataJson.dicomView` (additive, a
 *   cache: never touches the ingest keys or `updatedAt`, rebuilt when its
 *   version changes). A document without UIDs is its own study and series,
 *   keyed `doc:<documentId>`.
 * - Decoding. Native (uncompressed) pixel data only: Implicit VR LE, Explicit
 *   VR LE, Deflated Explicit VR LE and Explicit VR BE; 8 and 16-bit grayscale
 *   (MONOCHROME1/2, signed or unsigned, any BitsStored) and 8-bit RGB or
 *   YBR_FULL. Rescale slope/intercept, then the VOI window (LINEAR as in
 *   PS3.3 C.11.2.1.2.1, LINEAR_EXACT, SIGMOID) to 8 bits. Compressed syntaxes
 *   (JPEG, JPEG-LS, JPEG 2000, RLE, video) and other photometric
 *   interpretations raise DicomUnsupportedError (HTTP 415, with the name).
 * - PNG. A small encoder over node:zlib (per-row None/Sub/Up filter, CRC-32
 *   computed here).
 * - Caches. Decrypted files (4 entries), decoded frames (256 MB) and PNGs
 *   (96 MB) live in memory only and are cleared on lock. Every request checks
 *   the document is live before anything is served from a cache.
 */
import { deflateSync, inflateRawSync } from 'node:zlib';
import * as dicomNs from 'dicom-parser';
import type { DataSet, Element } from 'dicom-parser';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema, LockedError } from '../db';
import { getFile } from '../files/store';
import { onLockChange } from '../auth';
import { HttpError, notFound } from '../util/errors';
import { nowIso, parseJson } from '../util/ids';
import { dicomDate } from '../ingest/dicom';

// dicom-parser ships a UMD build; under Node ESM the API lives on `default` (as in ingest/dicom.ts).
const dicomParser = ((dicomNs as unknown as { default?: typeof dicomNs }).default ?? dicomNs) as typeof dicomNs;

/** Bump when the stored index gains or changes fields; older indexes are rebuilt on read. */
export const DICOM_INDEX_VERSION = 1;

// ---------------------------------------------------------------------------
// Transfer syntaxes
// ---------------------------------------------------------------------------

export const TS_IMPLICIT_LE = '1.2.840.10008.1.2';
export const TS_EXPLICIT_LE = '1.2.840.10008.1.2.1';
export const TS_DEFLATED_LE = '1.2.840.10008.1.2.1.99';
export const TS_EXPLICIT_BE = '1.2.840.10008.1.2.2';

/** Transfer syntaxes whose pixel data this build decodes (native, not encapsulated). */
const NATIVE_SYNTAXES = new Set([TS_IMPLICIT_LE, TS_EXPLICIT_LE, TS_DEFLATED_LE, TS_EXPLICIT_BE]);

export const TRANSFER_SYNTAX_NAMES: Record<string, string> = {
  [TS_IMPLICIT_LE]: 'Implicit VR Little Endian',
  [TS_EXPLICIT_LE]: 'Explicit VR Little Endian',
  [TS_DEFLATED_LE]: 'Deflated Explicit VR Little Endian',
  [TS_EXPLICIT_BE]: 'Explicit VR Big Endian',
  '1.2.840.10008.1.2.1.98': 'Encapsulated Uncompressed Explicit VR Little Endian',
  '1.2.840.10008.1.2.4.50': 'JPEG Baseline (Process 1)',
  '1.2.840.10008.1.2.4.51': 'JPEG Extended (Process 2 and 4)',
  '1.2.840.10008.1.2.4.57': 'JPEG Lossless, Non-Hierarchical (Process 14)',
  '1.2.840.10008.1.2.4.70': 'JPEG Lossless, First-Order Prediction (Process 14, SV1)',
  '1.2.840.10008.1.2.4.80': 'JPEG-LS Lossless',
  '1.2.840.10008.1.2.4.81': 'JPEG-LS Lossy (Near-Lossless)',
  '1.2.840.10008.1.2.4.90': 'JPEG 2000 (Lossless Only)',
  '1.2.840.10008.1.2.4.91': 'JPEG 2000',
  '1.2.840.10008.1.2.4.92': 'JPEG 2000 Part 2 Multi-component (Lossless Only)',
  '1.2.840.10008.1.2.4.93': 'JPEG 2000 Part 2 Multi-component',
  '1.2.840.10008.1.2.4.94': 'JPIP Referenced',
  '1.2.840.10008.1.2.4.95': 'JPIP Referenced Deflate',
  '1.2.840.10008.1.2.4.100': 'MPEG2 Main Profile / Main Level',
  '1.2.840.10008.1.2.4.101': 'MPEG2 Main Profile / High Level',
  '1.2.840.10008.1.2.4.102': 'MPEG-4 AVC/H.264 High Profile / Level 4.1',
  '1.2.840.10008.1.2.4.103': 'MPEG-4 AVC/H.264 BD-compatible High Profile / Level 4.1',
  '1.2.840.10008.1.2.4.104': 'MPEG-4 AVC/H.264 High Profile / Level 4.2 For 2D Video',
  '1.2.840.10008.1.2.4.105': 'MPEG-4 AVC/H.264 High Profile / Level 4.2 For 3D Video',
  '1.2.840.10008.1.2.4.106': 'MPEG-4 AVC/H.264 Stereo High Profile / Level 4.2',
  '1.2.840.10008.1.2.4.107': 'HEVC/H.265 Main Profile / Level 5.1',
  '1.2.840.10008.1.2.4.108': 'HEVC/H.265 Main 10 Profile / Level 5.1',
  '1.2.840.10008.1.2.4.110': 'JPEG XL Lossless',
  '1.2.840.10008.1.2.4.111': 'JPEG XL JPEG Recompression',
  '1.2.840.10008.1.2.4.112': 'JPEG XL',
  '1.2.840.10008.1.2.4.201': 'High-Throughput JPEG 2000 (Lossless Only)',
  '1.2.840.10008.1.2.4.202': 'High-Throughput JPEG 2000 with RPCL Options (Lossless Only)',
  '1.2.840.10008.1.2.4.203': 'High-Throughput JPEG 2000',
  '1.2.840.10008.1.2.5': 'RLE Lossless',
  '1.2.840.10008.1.2.6.1': 'RFC 2557 MIME encapsulation',
  '1.2.840.10008.1.2.6.2': 'XML Encoding',
};

export function transferSyntaxName(uid: string | null | undefined): string {
  if (!uid) return 'Implicit VR Little Endian (assumed: no file meta header)';
  return TRANSFER_SYNTAX_NAMES[uid] ?? `unknown transfer syntax ${uid}`;
}

export function isNativeSyntax(uid: string | null | undefined): boolean {
  return NATIVE_SYNTAXES.has(uid || TS_IMPLICIT_LE);
}

/** A file this build cannot turn into pixels: a compressed syntax or an unsupported pixel layout. Answered with 415. */
export class DicomUnsupportedError extends HttpError {
  constructor(
    message: string,
    public transferSyntaxUid: string | null,
    public transferSyntaxName: string,
    public reason: 'compressed' | 'photometric' | 'bits',
  ) {
    super(415, message);
    this.name = 'DicomUnsupportedError';
  }
}

// ---------------------------------------------------------------------------
// Tag dictionary (about 140 common tags; VR is used for implicit files)
// ---------------------------------------------------------------------------

const DICT: Record<string, [string, string]> = {
  '00020000': ['UL', 'File Meta Information Group Length'],
  '00020001': ['OB', 'File Meta Information Version'],
  '00020002': ['UI', 'Media Storage SOP Class UID'],
  '00020003': ['UI', 'Media Storage SOP Instance UID'],
  '00020010': ['UI', 'Transfer Syntax UID'],
  '00020012': ['UI', 'Implementation Class UID'],
  '00020013': ['SH', 'Implementation Version Name'],
  '00020016': ['AE', 'Source Application Entity Title'],
  '00080005': ['CS', 'Specific Character Set'],
  '00080008': ['CS', 'Image Type'],
  '00080012': ['DA', 'Instance Creation Date'],
  '00080013': ['TM', 'Instance Creation Time'],
  '00080016': ['UI', 'SOP Class UID'],
  '00080018': ['UI', 'SOP Instance UID'],
  '00080020': ['DA', 'Study Date'],
  '00080021': ['DA', 'Series Date'],
  '00080022': ['DA', 'Acquisition Date'],
  '00080023': ['DA', 'Content Date'],
  '00080030': ['TM', 'Study Time'],
  '00080031': ['TM', 'Series Time'],
  '00080032': ['TM', 'Acquisition Time'],
  '00080033': ['TM', 'Content Time'],
  '00080050': ['SH', 'Accession Number'],
  '00080060': ['CS', 'Modality'],
  '00080064': ['CS', 'Conversion Type'],
  '00080070': ['LO', 'Manufacturer'],
  '00080080': ['LO', 'Institution Name'],
  '00080081': ['ST', 'Institution Address'],
  '00080090': ['PN', "Referring Physician's Name"],
  '00080100': ['SH', 'Code Value'],
  '00080102': ['SH', 'Coding Scheme Designator'],
  '00080104': ['LO', 'Code Meaning'],
  '00081010': ['SH', 'Station Name'],
  '00081030': ['LO', 'Study Description'],
  '00081032': ['SQ', 'Procedure Code Sequence'],
  '0008103E': ['LO', 'Series Description'],
  '00081040': ['LO', 'Institutional Department Name'],
  '00081050': ['PN', "Performing Physician's Name"],
  '00081060': ['PN', 'Name of Physician(s) Reading Study'],
  '00081070': ['PN', "Operators' Name"],
  '00081090': ['LO', "Manufacturer's Model Name"],
  '00081111': ['SQ', 'Referenced Performed Procedure Step Sequence'],
  '00081140': ['SQ', 'Referenced Image Sequence'],
  '00081150': ['UI', 'Referenced SOP Class UID'],
  '00081155': ['UI', 'Referenced SOP Instance UID'],
  '00082111': ['ST', 'Derivation Description'],
  '00100010': ['PN', "Patient's Name"],
  '00100020': ['LO', 'Patient ID'],
  '00100030': ['DA', "Patient's Birth Date"],
  '00100040': ['CS', "Patient's Sex"],
  '00101010': ['AS', "Patient's Age"],
  '00101020': ['DS', "Patient's Size"],
  '00101030': ['DS', "Patient's Weight"],
  '00104000': ['LT', 'Patient Comments'],
  '00180010': ['LO', 'Contrast/Bolus Agent'],
  '00180015': ['CS', 'Body Part Examined'],
  '00180020': ['CS', 'Scanning Sequence'],
  '00180021': ['CS', 'Sequence Variant'],
  '00180022': ['CS', 'Scan Options'],
  '00180023': ['CS', 'MR Acquisition Type'],
  '00180024': ['SH', 'Sequence Name'],
  '00180050': ['DS', 'Slice Thickness'],
  '00180060': ['DS', 'KVP'],
  '00180080': ['DS', 'Repetition Time'],
  '00180081': ['DS', 'Echo Time'],
  '00180082': ['DS', 'Inversion Time'],
  '00180083': ['DS', 'Number of Averages'],
  '00180084': ['DS', 'Imaging Frequency'],
  '00180087': ['DS', 'Magnetic Field Strength'],
  '00180088': ['DS', 'Spacing Between Slices'],
  '00180091': ['IS', 'Echo Train Length'],
  '00180095': ['DS', 'Pixel Bandwidth'],
  '00181000': ['LO', 'Device Serial Number'],
  '00181020': ['LO', 'Software Versions'],
  '00181030': ['LO', 'Protocol Name'],
  '00181100': ['DS', 'Reconstruction Diameter'],
  '00181110': ['DS', 'Distance Source to Detector'],
  '00181111': ['DS', 'Distance Source to Patient'],
  '00181120': ['DS', 'Gantry/Detector Tilt'],
  '00181130': ['DS', 'Table Height'],
  '00181140': ['CS', 'Rotation Direction'],
  '00181150': ['IS', 'Exposure Time'],
  '00181151': ['IS', 'X-Ray Tube Current'],
  '00181152': ['IS', 'Exposure'],
  '00181160': ['SH', 'Filter Type'],
  '00181164': ['DS', 'Imager Pixel Spacing'],
  '00181170': ['IS', 'Generator Power'],
  '00181190': ['DS', 'Focal Spot(s)'],
  '00181210': ['SH', 'Convolution Kernel'],
  '00181250': ['SH', 'Receive Coil Name'],
  '00181310': ['US', 'Acquisition Matrix'],
  '00181314': ['DS', 'Flip Angle'],
  '00185100': ['CS', 'Patient Position'],
  '00189087': ['FD', 'Diffusion b-value'],
  '0020000D': ['UI', 'Study Instance UID'],
  '0020000E': ['UI', 'Series Instance UID'],
  '00200010': ['SH', 'Study ID'],
  '00200011': ['IS', 'Series Number'],
  '00200012': ['IS', 'Acquisition Number'],
  '00200013': ['IS', 'Instance Number'],
  '00200020': ['CS', 'Patient Orientation'],
  '00200032': ['DS', 'Image Position (Patient)'],
  '00200037': ['DS', 'Image Orientation (Patient)'],
  '00200052': ['UI', 'Frame of Reference UID'],
  '00200060': ['CS', 'Laterality'],
  '00200062': ['CS', 'Image Laterality'],
  '00201040': ['LO', 'Position Reference Indicator'],
  '00201041': ['DS', 'Slice Location'],
  '00204000': ['LT', 'Image Comments'],
  '00280002': ['US', 'Samples per Pixel'],
  '00280004': ['CS', 'Photometric Interpretation'],
  '00280006': ['US', 'Planar Configuration'],
  '00280008': ['IS', 'Number of Frames'],
  '00280010': ['US', 'Rows'],
  '00280011': ['US', 'Columns'],
  '00280030': ['DS', 'Pixel Spacing'],
  '00280034': ['IS', 'Pixel Aspect Ratio'],
  '00280100': ['US', 'Bits Allocated'],
  '00280101': ['US', 'Bits Stored'],
  '00280102': ['US', 'High Bit'],
  '00280103': ['US', 'Pixel Representation'],
  '00280106': ['US', 'Smallest Image Pixel Value'],
  '00280107': ['US', 'Largest Image Pixel Value'],
  '00280120': ['US', 'Pixel Padding Value'],
  '00281040': ['CS', 'Pixel Intensity Relationship'],
  '00281050': ['DS', 'Window Center'],
  '00281051': ['DS', 'Window Width'],
  '00281052': ['DS', 'Rescale Intercept'],
  '00281053': ['DS', 'Rescale Slope'],
  '00281054': ['LO', 'Rescale Type'],
  '00281055': ['LO', 'Window Center & Width Explanation'],
  '00281056': ['CS', 'VOI LUT Function'],
  '00282110': ['CS', 'Lossy Image Compression'],
  '00282112': ['DS', 'Lossy Image Compression Ratio'],
  '00282114': ['CS', 'Lossy Image Compression Method'],
  '00283000': ['SQ', 'Modality LUT Sequence'],
  '00283010': ['SQ', 'VOI LUT Sequence'],
  '00321060': ['LO', 'Requested Procedure Description'],
  '00400244': ['DA', 'Performed Procedure Step Start Date'],
  '00400245': ['TM', 'Performed Procedure Step Start Time'],
  '00400253': ['SH', 'Performed Procedure Step ID'],
  '00400254': ['LO', 'Performed Procedure Step Description'],
  '00540081': ['US', 'Number of Slices'],
  '00880200': ['SQ', 'Icon Image Sequence'],
  '7FE00010': ['OW', 'Pixel Data'],
  FFFEE000: ['', 'Item'],
  FFFEE00D: ['', 'Item Delimitation Item'],
  FFFEE0DD: ['', 'Sequence Delimitation Item'],
};

export const DICOM_DICTIONARY_SIZE = Object.keys(DICT).length;

/** Name and dictionary VR of a tag in the `xGGGGEEEE` form dicom-parser uses. */
export function tagInfo(key: string): { name: string; vr: string | null; private: boolean } {
  const hex = key.replace(/^x/i, '').toUpperCase();
  const hit = DICT[hex];
  if (hit) return { name: hit[1], vr: hit[0] || null, private: false };
  const group = parseInt(hex.slice(0, 4), 16);
  const element = parseInt(hex.slice(4), 16);
  if (element === 0) return { name: 'Group Length', vr: 'UL', private: false };
  if (group % 2 === 1) return { name: element >= 0x10 && element <= 0xff ? 'Private Creator' : 'Private tag', vr: element >= 0x10 && element <= 0xff ? 'LO' : null, private: true };
  return { name: 'Unknown tag', vr: null, private: false };
}

export function formatTag(key: string): string {
  const hex = key.replace(/^x/i, '').toUpperCase();
  return `(${hex.slice(0, 4)},${hex.slice(4, 8)})`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParsedDicom {
  ds: DataSet;
  /** Null when the file had no meta header (read as Implicit VR Little Endian). */
  transferSyntaxUid: string | null;
  part10: boolean;
  warnings: string[];
}

function parserMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const ex = (e as { exception?: unknown }).exception;
    if (ex !== undefined) return parserMessage(ex);
    if (e instanceof Error) return e.message;
  }
  return String(e);
}

/** dicom-parser reads a Deflated Explicit VR LE data set through this callback (it expects the whole array back). */
function inflater(arr: Uint8Array, position: number): Uint8Array {
  const inflated = inflateRawSync(arr.subarray(position));
  const full = new Uint8Array(position + inflated.length);
  full.set(arr.subarray(0, position), 0);
  full.set(inflated, position);
  return full;
}

function tryParse(bytes: Uint8Array, ts?: string): { ds: DataSet; warnings: string[] } {
  const options = { inflater, ...(ts ? { TransferSyntaxUID: ts } : {}) } as unknown as Parameters<typeof dicomParser.parseDicom>[1];
  try {
    const ds = dicomParser.parseDicom(bytes, options);
    return { ds, warnings: [...(ds.warnings ?? [])] };
  } catch (e) {
    // A file cut short still yields the elements read before the cut; keep them and say so.
    const partial = (e as { dataSet?: DataSet } | null)?.dataSet;
    if (partial && Object.keys(partial.elements ?? {}).length > 3) return { ds: partial, warnings: [`read partially: ${parserMessage(e)}`] };
    throw e;
  }
}

/** Parse a whole DICOM file; a file without the DICM preamble is read as a raw Implicit (then Explicit) VR LE data set. */
export function parseDicomFile(buffer: Buffer): ParsedDicom {
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  try {
    const { ds, warnings } = tryParse(bytes);
    return { ds, transferSyntaxUid: readString(ds, 'x00020010') ?? null, part10: true, warnings };
  } catch (e) {
    const msg = parserMessage(e);
    if (!/DICM prefix not found/i.test(msg)) throw new HttpError(422, `not a readable DICOM file: ${msg}`);
  }
  for (const ts of [TS_IMPLICIT_LE, TS_EXPLICIT_LE]) {
    try {
      const { ds, warnings } = tryParse(bytes, ts);
      const keys = Object.keys(ds.elements ?? {});
      // A raw data set must at least look like one: some image or study attributes, in tag order.
      if (keys.some((k) => /^x00(08|10|20|28)/.test(k))) return { ds, transferSyntaxUid: null, part10: false, warnings: [...warnings, `no DICM preamble: read as ${TRANSFER_SYNTAX_NAMES[ts]}`] };
    } catch {
      // try the next reading
    }
  }
  throw new HttpError(422, 'not a readable DICOM file: no DICM preamble and no recognisable data set');
}

function clean(s: string | undefined | null): string | undefined {
  const t = (s ?? '').replace(/\0/g, '').trim();
  return t ? t : undefined;
}

/** A string attribute as stored (multi-valued kept with backslashes); never throws. */
export function readString(ds: DataSet, tag: string): string | undefined {
  try {
    return clean(ds.string(tag));
  } catch {
    return undefined;
  }
}

function readValues(ds: DataSet, tag: string): string[] {
  const s = readString(ds, tag);
  return s ? s.split('\\').map((x) => x.trim()) : [];
}

/** A DS or IS value (first of a multi-valued one) as a finite number. */
function readNumber(ds: DataSet, tag: string, index = 0): number | undefined {
  const v = readValues(ds, tag)[index];
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function readNumbers(ds: DataSet, tag: string): number[] | undefined {
  const vals = readValues(ds, tag).map(Number);
  return vals.length && vals.every(Number.isFinite) ? vals : undefined;
}

function readUs(ds: DataSet, tag: string): number | undefined {
  const e = ds.elements[tag];
  if (!e || e.length < 2) return undefined;
  try {
    return ds.uint16(tag);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Index (what the viewer needs from each file, kept in metadataJson.dicomView)
// ---------------------------------------------------------------------------

export interface DicomIndex {
  v: number;
  at: string;
  part10: boolean;
  transferSyntaxUid: string | null;
  sopClassUid?: string;
  studyUid?: string;
  seriesUid?: string;
  sopUid?: string;
  modality?: string;
  studyDate?: string;
  studyTime?: string;
  seriesDate?: string;
  seriesTime?: string;
  studyDescription?: string;
  seriesDescription?: string;
  bodyPart?: string;
  institution?: string;
  accession?: string;
  patientName?: string;
  patientId?: string;
  seriesNumber?: number;
  instanceNumber?: number;
  acquisitionNumber?: number;
  sliceLocation?: number;
  sliceThickness?: number;
  spacingBetweenSlices?: number;
  imagePosition?: number[];
  pixelSpacing?: number[];
  rows?: number;
  columns?: number;
  frames: number;
  bitsAllocated?: number;
  bitsStored?: number;
  highBit?: number;
  pixelRepresentation?: number;
  samplesPerPixel?: number;
  photometric?: string;
  planarConfiguration?: number;
  rescaleSlope?: number;
  rescaleIntercept?: number;
  rescaleType?: string;
  windowCenter?: number;
  windowWidth?: number;
  windowExplanation?: string;
  voiLutFunction?: string;
  hasPixelData: boolean;
  encapsulated: boolean;
  pixelDataLength?: number;
  warnings?: string[];
  /** Set when the file could not be read at all. */
  error?: string;
}

function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}

/** The viewer's index of one parsed file. */
export function indexDataSet(p: ParsedDicom): DicomIndex {
  const { ds } = p;
  const pixel = ds.elements.x7fe00010 as Element | undefined;
  const encapsulated = Boolean(pixel && (pixel.encapsulatedPixelData || pixel.hadUndefinedLength));
  const frames = readNumber(ds, 'x00280008');
  const name = readString(ds, 'x00100010');
  return compact<DicomIndex>({
    v: DICOM_INDEX_VERSION,
    at: nowIso(),
    part10: p.part10,
    transferSyntaxUid: p.transferSyntaxUid,
    sopClassUid: readString(ds, 'x00080016') ?? readString(ds, 'x00020002'),
    studyUid: readString(ds, 'x0020000d'),
    seriesUid: readString(ds, 'x0020000e'),
    sopUid: readString(ds, 'x00080018') ?? readString(ds, 'x00020003'),
    modality: readString(ds, 'x00080060'),
    studyDate: readString(ds, 'x00080020'),
    studyTime: readString(ds, 'x00080030'),
    seriesDate: readString(ds, 'x00080021'),
    seriesTime: readString(ds, 'x00080031'),
    studyDescription: readString(ds, 'x00081030'),
    seriesDescription: readString(ds, 'x0008103e'),
    bodyPart: readString(ds, 'x00180015'),
    institution: readString(ds, 'x00080080'),
    accession: readString(ds, 'x00080050'),
    patientName: name ? name.replace(/\^+/g, ' ').trim() : undefined,
    patientId: readString(ds, 'x00100020'),
    seriesNumber: readNumber(ds, 'x00200011'),
    instanceNumber: readNumber(ds, 'x00200013'),
    acquisitionNumber: readNumber(ds, 'x00200012'),
    sliceLocation: readNumber(ds, 'x00201041'),
    sliceThickness: readNumber(ds, 'x00180050'),
    spacingBetweenSlices: readNumber(ds, 'x00180088'),
    imagePosition: readNumbers(ds, 'x00200032'),
    pixelSpacing: readNumbers(ds, 'x00280030') ?? readNumbers(ds, 'x00181164'),
    rows: readUs(ds, 'x00280010'),
    columns: readUs(ds, 'x00280011'),
    frames: frames && frames > 0 ? Math.floor(frames) : 1,
    bitsAllocated: readUs(ds, 'x00280100'),
    bitsStored: readUs(ds, 'x00280101'),
    highBit: readUs(ds, 'x00280102'),
    pixelRepresentation: readUs(ds, 'x00280103'),
    samplesPerPixel: readUs(ds, 'x00280002'),
    photometric: readString(ds, 'x00280004')?.toUpperCase(),
    planarConfiguration: readUs(ds, 'x00280006'),
    rescaleSlope: readNumber(ds, 'x00281053'),
    rescaleIntercept: readNumber(ds, 'x00281052'),
    rescaleType: readString(ds, 'x00281054'),
    windowCenter: readNumber(ds, 'x00281050'),
    windowWidth: readNumber(ds, 'x00281051'),
    windowExplanation: readString(ds, 'x00281055'),
    voiLutFunction: readString(ds, 'x00281056')?.toUpperCase(),
    hasPixelData: Boolean(pixel),
    encapsulated,
    pixelDataLength: pixel && !encapsulated ? pixel.length : undefined,
    warnings: p.warnings.length ? p.warnings.slice(0, 10) : undefined,
  });
}

/** Why a file's pixels cannot be shown in this build, or null when they can. */
export function undecodableReason(ix: Pick<DicomIndex, 'transferSyntaxUid' | 'encapsulated' | 'hasPixelData' | 'photometric' | 'bitsAllocated' | 'samplesPerPixel' | 'error'>): string | null {
  if (ix.error) return ix.error;
  if (!ix.hasPixelData) return 'this DICOM object holds no image (no pixel data)';
  if (!isNativeSyntax(ix.transferSyntaxUid) || ix.encapsulated) return `not decodable in this build: ${transferSyntaxName(ix.transferSyntaxUid)}`;
  const spp = ix.samplesPerPixel ?? 1;
  const pi = ix.photometric ?? (spp === 3 ? 'RGB' : 'MONOCHROME2');
  if (spp === 1 && pi !== 'MONOCHROME1' && pi !== 'MONOCHROME2') return `not decodable in this build: photometric interpretation ${pi}`;
  if (spp === 3 && pi !== 'RGB' && pi !== 'YBR_FULL') return `not decodable in this build: photometric interpretation ${pi}`;
  if (spp !== 1 && spp !== 3) return `not decodable in this build: ${spp} samples per pixel`;
  const bits = ix.bitsAllocated ?? 16;
  if (spp === 1 && bits !== 8 && bits !== 16) return `not decodable in this build: ${bits}-bit pixels`;
  if (spp === 3 && bits !== 8) return `not decodable in this build: ${bits}-bit colour`;
  return null;
}

/**
 * Throw why a file cannot be shown: 422 for a file that could not be read, 404
 * when it holds no image, 415 (DicomUnsupportedError, with the syntax name) for
 * a compressed syntax or a pixel layout this build does not decode.
 */
export function assertDecodable(ix: DicomIndex): void {
  const reason = undecodableReason(ix);
  if (!reason) return;
  if (ix.error) throw new HttpError(422, ix.error);
  if (!ix.hasPixelData) throw notFound(reason);
  const compressed = !isNativeSyntax(ix.transferSyntaxUid) || ix.encapsulated;
  throw new DicomUnsupportedError(reason, ix.transferSyntaxUid, transferSyntaxName(ix.transferSyntaxUid), compressed ? 'compressed' : reason.includes('photometric') ? 'photometric' : 'bits');
}

// ---------------------------------------------------------------------------
// Window / level
// ---------------------------------------------------------------------------

export type VoiFunction = 'LINEAR' | 'LINEAR_EXACT' | 'SIGMOID';

/**
 * Map one modality value to 0..255 with a VOI window. LINEAR follows PS3.3
 * C.11.2.1.2.1 (width >= 1): below c - 0.5 - (w-1)/2 is 0, above
 * c - 0.5 + (w-1)/2 is 255, linear between. LINEAR_EXACT (also used for any
 * width under 1) and SIGMOID follow C.11.2.1.3.
 */
export function windowLevel(value: number, center: number, width: number, fn: VoiFunction = 'LINEAR'): number {
  if (fn === 'SIGMOID') {
    const w = width > 0 ? width : 1;
    return clamp255(255 / (1 + Math.exp((-4 * (value - center)) / w)));
  }
  if (fn === 'LINEAR_EXACT' || width < 1) {
    const w = width > 0 ? width : 1e-9;
    if (value <= center - w / 2) return 0;
    if (value > center + w / 2) return 255;
    return clamp255(((value - center) / w + 0.5) * 255);
  }
  const lo = center - 0.5 - (width - 1) / 2;
  const hi = center - 0.5 + (width - 1) / 2;
  if (value <= lo) return 0;
  if (value > hi) return 255;
  return clamp255(((value - (center - 0.5)) / (width - 1) + 0.5) * 255);
}

function clamp255(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

// ---------------------------------------------------------------------------
// Pixel decoding
// ---------------------------------------------------------------------------

export type DecodedFrame =
  | { kind: 'gray'; rows: number; columns: number; raw: Int32Array; minRaw: number; maxRaw: number; slope: number; intercept: number; invert: boolean; bytes: number }
  | { kind: 'rgb'; rows: number; columns: number; rgb: Uint8Array; bytes: number };

/** Decode frame `frameIndex` (0-based) of a parsed file into stored values (grey) or RGB bytes. */
export function decodeFrame(p: ParsedDicom, frameIndex = 0): DecodedFrame {
  const ix = indexDataSet(p);
  assertDecodable(ix);
  const rows = ix.rows ?? 0;
  const columns = ix.columns ?? 0;
  if (!rows || !columns) throw new HttpError(422, 'the file has no Rows or Columns, so its pixels cannot be laid out');
  if (frameIndex < 0 || frameIndex >= ix.frames) throw notFound(`frame ${frameIndex + 1} does not exist (this instance has ${ix.frames})`);
  const { ds } = p;
  const pixel = ds.elements.x7fe00010 as Element;
  const bytes = ds.byteArray as Uint8Array;
  const spp = ix.samplesPerPixel ?? 1;
  const bitsAllocated = ix.bitsAllocated ?? 16;
  const bytesPer = bitsAllocated / 8;
  const frameBytes = rows * columns * spp * bytesPer;
  const start = pixel.dataOffset + frameIndex * frameBytes;
  const available = Math.min(pixel.length, bytes.length - pixel.dataOffset);
  if ((frameIndex + 1) * frameBytes > available) {
    throw new HttpError(422, `the pixel data is shorter than its header says (${available} bytes for ${ix.frames} frame${ix.frames === 1 ? '' : 's'} of ${rows} x ${columns}${spp === 3 ? ' RGB' : ''} at ${bitsAllocated} bits)`);
  }
  const n = rows * columns;

  if (spp === 3) {
    const rgb = new Uint8Array(n * 3);
    const planar = ix.planarConfiguration === 1;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = planar ? bytes[start + c * n + i] : bytes[start + i * 3 + c];
    }
    if (ix.photometric === 'YBR_FULL') {
      for (let i = 0; i < n; i++) {
        const y = rgb[i * 3];
        const cb = rgb[i * 3 + 1] - 128;
        const cr = rgb[i * 3 + 2] - 128;
        rgb[i * 3] = clamp255(y + 1.402 * cr);
        rgb[i * 3 + 1] = clamp255(y - 0.344136 * cb - 0.714136 * cr);
        rgb[i * 3 + 2] = clamp255(y + 1.772 * cb);
      }
    }
    return { kind: 'rgb', rows, columns, rgb, bytes: rgb.byteLength };
  }

  const bitsStored = Math.min(ix.bitsStored ?? bitsAllocated, bitsAllocated);
  const highBit = ix.highBit ?? bitsStored - 1;
  const shift = Math.max(0, highBit - bitsStored + 1);
  const mask = bitsStored >= 32 ? 0xffffffff : (1 << bitsStored) - 1;
  const signed = ix.pixelRepresentation === 1;
  const signBit = 1 << (bitsStored - 1);
  const bigEndian = p.transferSyntaxUid === TS_EXPLICIT_BE;
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, frameBytes);
  const raw = new Int32Array(n);
  let minRaw = Infinity;
  let maxRaw = -Infinity;
  for (let i = 0; i < n; i++) {
    let v = bytesPer === 1 ? view.getUint8(i) : view.getUint16(i * 2, !bigEndian);
    v = (v >>> shift) & mask;
    if (signed && v & signBit) v -= 1 << bitsStored;
    raw[i] = v;
    if (v < minRaw) minRaw = v;
    if (v > maxRaw) maxRaw = v;
  }
  const slope = ix.rescaleSlope !== undefined && ix.rescaleSlope !== 0 ? ix.rescaleSlope : 1;
  const intercept = ix.rescaleIntercept ?? 0;
  return { kind: 'gray', rows, columns, raw, minRaw, maxRaw, slope, intercept, invert: ix.photometric === 'MONOCHROME1', bytes: raw.byteLength };
}

/** Modality values (after rescale) of a decoded grey frame: lowest and highest. */
export function modalityRange(f: Extract<DecodedFrame, { kind: 'gray' }>): { min: number; max: number } {
  const a = f.minRaw * f.slope + f.intercept;
  const b = f.maxRaw * f.slope + f.intercept;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

export interface WindowChoice {
  center: number;
  width: number;
  /** request: from ?wc/&ww=; file: the file's WindowCenter/Width; computed: the frame's full range; none: colour. */
  source: 'request' | 'file' | 'computed' | 'none';
  fn: VoiFunction;
}

/** The window a frame is shown with: the request's, else the file's, else the frame's full range. */
export function chooseWindow(ix: Pick<DicomIndex, 'windowCenter' | 'windowWidth' | 'voiLutFunction'>, frame: DecodedFrame, req: { wc?: number; ww?: number } = {}): WindowChoice {
  if (frame.kind === 'rgb') return { center: 0, width: 0, source: 'none', fn: 'LINEAR' };
  const fileFn: VoiFunction = ix.voiLutFunction === 'SIGMOID' ? 'SIGMOID' : ix.voiLutFunction === 'LINEAR_EXACT' ? 'LINEAR_EXACT' : 'LINEAR';
  const fileOk = ix.windowCenter !== undefined && ix.windowWidth !== undefined && ix.windowWidth > 0;
  const range = modalityRange(frame);
  const computed = { center: (range.min + range.max) / 2, width: Math.max(range.max - range.min, 1) };
  const base = fileOk ? { center: ix.windowCenter as number, width: ix.windowWidth as number } : computed;
  if (req.wc !== undefined || req.ww !== undefined) {
    // A request window is always linear: the keys and presets step it in modality units.
    return { center: req.wc ?? base.center, width: req.ww ?? base.width, source: 'request', fn: 'LINEAR' };
  }
  return fileOk ? { ...base, source: 'file', fn: fileFn } : { ...computed, source: 'computed', fn: 'LINEAR' };
}

export interface RenderedFrame {
  width: number;
  height: number;
  channels: 1 | 3;
  data: Uint8Array;
}

/** Window a grey frame to 8 bits (MONOCHROME1 inverted) or pass RGB through; then resample by `scale`. */
export function renderFrame(frame: DecodedFrame, win: WindowChoice, scale = 1): RenderedFrame {
  let out: RenderedFrame;
  if (frame.kind === 'rgb') {
    out = { width: frame.columns, height: frame.rows, channels: 3, data: frame.rgb };
  } else {
    const n = frame.raw.length;
    const data = new Uint8Array(n);
    const span = frame.maxRaw - frame.minRaw;
    if (span <= 1 << 20) {
      // One lookup entry per stored value: cheap even for 16 bits.
      const lut = new Uint8Array(span + 1);
      for (let r = 0; r <= span; r++) {
        const y = windowLevel((frame.minRaw + r) * frame.slope + frame.intercept, win.center, win.width, win.fn);
        lut[r] = frame.invert ? 255 - y : y;
      }
      for (let i = 0; i < n; i++) data[i] = lut[frame.raw[i] - frame.minRaw];
    } else {
      for (let i = 0; i < n; i++) {
        const y = windowLevel(frame.raw[i] * frame.slope + frame.intercept, win.center, win.width, win.fn);
        data[i] = frame.invert ? 255 - y : y;
      }
    }
    out = { width: frame.columns, height: frame.rows, channels: 1, data };
  }
  return Math.abs(scale - 1) < 1e-6 ? out : resample(out, scale);
}

/** Box-filter downscale (area average) or nearest-neighbour upscale. */
export function resample(img: RenderedFrame, scale: number): RenderedFrame {
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const ch = img.channels;
  const out = new Uint8Array(w * h * ch);
  const fx = img.width / w;
  const fy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.min(img.height, Math.floor((y + 1) * fy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.min(img.width, Math.floor((x + 1) * fx)));
      for (let c = 0; c < ch; c++) {
        let sum = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += img.data[(yy * img.width + xx) * ch + c];
        out[(y * w + x) * ch + c] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
      }
    }
  }
  return { width: w, height: h, channels: ch, data: out };
}

// ---------------------------------------------------------------------------
// PNG encoder (8-bit grey or RGB)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array, crc = 0): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode 8-bit grey (channels 1) or RGB (channels 3) pixels as a PNG; each row takes whichever of None, Sub or Up is smallest. */
export function encodePng(img: RenderedFrame): Buffer {
  const { width, height, channels, data } = img;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  const sub = new Uint8Array(stride);
  const up = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    let sNone = 0;
    let sSub = 0;
    let sUp = 0;
    for (let x = 0; x < stride; x++) {
      const v = row[x];
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      sub[x] = (v - a) & 0xff;
      up[x] = (v - b) & 0xff;
      sNone += v < 128 ? v : 256 - v;
      sSub += sub[x] < 128 ? sub[x] : 256 - sub[x];
      sUp += up[x] < 128 ? up[x] : 256 - up[x];
    }
    const o = y * (stride + 1);
    if (sSub <= sNone && sSub <= sUp) {
      raw[o] = 1;
      raw.set(sub, o + 1);
    } else if (sUp < sNone) {
      raw[o] = 2;
      raw.set(up, o + 1);
    } else {
      raw[o] = 0;
      raw.set(row, o + 1);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 3 ? 2 : 0;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 4 })), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export interface DicomTag {
  /** "(0028,0010)" */
  tag: string;
  vr: string | null;
  name: string;
  value: string;
  /** 0 at the top level; items of a sequence are one deeper. */
  depth: number;
  private: boolean;
}

const STRING_VRS = new Set(['AE', 'AS', 'CS', 'DA', 'DS', 'DT', 'IS', 'LO', 'LT', 'PN', 'SH', 'ST', 'TM', 'UC', 'UI', 'UR', 'UT']);
const MAX_VALUE = 240;
const MAX_TAG_ROWS = 3000;

function elementValue(ds: DataSet, key: string, e: Element, vr: string | null): string {
  if (key === 'x7fe00010') return e.encapsulatedPixelData || e.hadUndefinedLength ? `<encapsulated, ${e.fragments?.length ?? '?'} fragment${e.fragments?.length === 1 ? '' : 's'}>` : `<binary, ${e.length} bytes>`;
  if (e.items) return `${e.items.length} item${e.items.length === 1 ? '' : 's'}`;
  if (e.length === 0) return '';
  if (e.length === 0xffffffff) return '<undefined length>';
  try {
    if (vr && STRING_VRS.has(vr)) {
      const s = vr === 'LT' || vr === 'ST' || vr === 'UT' ? ds.text(key) : ds.string(key);
      const t = (s ?? '').replace(/\0/g, '');
      return t.length > MAX_VALUE ? `${t.slice(0, MAX_VALUE)}…` : t;
    }
    const count = (size: number) => Math.min(16, Math.floor(e.length / size));
    const list = (size: number, read: (i: number) => number | undefined) => {
      const vals: string[] = [];
      for (let i = 0; i < count(size); i++) {
        const v = read(i);
        if (v !== undefined) vals.push(String(Number.isInteger(v) ? v : Number(v.toPrecision(8))));
      }
      return vals.join('\\') + (e.length / size > 16 ? '\\…' : '');
    };
    switch (vr) {
      case 'US':
        return list(2, (i) => ds.uint16(key, i));
      case 'SS':
        return list(2, (i) => ds.int16(key, i));
      case 'UL':
        return list(4, (i) => ds.uint32(key, i));
      case 'SL':
        return list(4, (i) => ds.int32(key, i));
      case 'FL':
        return list(4, (i) => ds.float(key, i));
      case 'FD':
        return list(8, (i) => ds.double(key, i));
      case 'AT':
        return ds.attributeTag(key) ?? '';
      default:
        return `<binary, ${e.length} bytes>`;
    }
  } catch {
    return `<unreadable, ${e.length} bytes>`;
  }
}

/** Every element of a data set in tag order, sequence items flattened one level deeper each. */
export function listTags(ds: DataSet, depth = 0, out: DicomTag[] = []): DicomTag[] {
  const keys = Object.keys(ds.elements).sort();
  for (const key of keys) {
    if (out.length >= MAX_TAG_ROWS) break;
    const e = ds.elements[key];
    // A raw data set (no meta header) carries a stand-in Transfer Syntax element with no bytes behind it: not in the file, so not listed.
    if (e.dataOffset === undefined && !e.items) continue;
    const info = tagInfo(key);
    const vr = e.vr ?? (e.items ? 'SQ' : info.vr);
    out.push({ tag: formatTag(key), vr: vr ?? null, name: info.name, value: elementValue(ds, key, e, vr ?? null), depth, private: info.private });
    if (e.items && depth < 4) {
      e.items.forEach((item, i) => {
        if (out.length >= MAX_TAG_ROWS) return;
        out.push({ tag: '(FFFE,E000)', vr: null, name: `Item ${i + 1}`, value: '', depth: depth + 1, private: false });
        if (item.dataSet) listTags(item.dataSet, depth + 2, out);
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Documents, caches and the index cache in metadataJson.dicomView
// ---------------------------------------------------------------------------

type DicomDocument = Pick<typeof schema.documents.$inferSelect, 'id' | 'title' | 'filename' | 'storageKey' | 'metadataJson' | 'documentDate' | 'documentDatePrecision' | 'sizeBytes' | 'createdAt' | 'kind'>;

const docColumns = {
  id: schema.documents.id,
  title: schema.documents.title,
  filename: schema.documents.filename,
  storageKey: schema.documents.storageKey,
  metadataJson: schema.documents.metadataJson,
  documentDate: schema.documents.documentDate,
  documentDatePrecision: schema.documents.documentDatePrecision,
  sizeBytes: schema.documents.sizeBytes,
  createdAt: schema.documents.createdAt,
  kind: schema.documents.kind,
};

function liveDicomDocuments(): DicomDocument[] {
  return db()
    .select(docColumns)
    .from(schema.documents)
    .where(and(eq(schema.documents.kind, 'dicom'), isNull(schema.documents.deletedAt)))
    .all();
}

/** A live document of kind dicom, or 404. */
export function dicomDocumentOr404(id: string): DicomDocument {
  const doc = db().select(docColumns).from(schema.documents).where(and(eq(schema.documents.id, id), isNull(schema.documents.deletedAt))).get();
  if (!doc) throw notFound('document not found');
  if (doc.kind !== 'dicom') throw notFound('this document is not a DICOM file');
  return doc;
}

const FILE_CACHE_MAX = 4;
const FILE_CACHE_BYTES = 384 * 1024 * 1024;
const FRAME_CACHE_BYTES = 256 * 1024 * 1024;
const PNG_CACHE_BYTES = 96 * 1024 * 1024;
const PNG_CACHE_MAX = 800;

interface FileEntry {
  parsed: ParsedDicom;
  bytes: number;
}

const fileCache = new Map<string, FileEntry>();
const frameCache = new Map<string, DecodedFrame>();
let frameBytes = 0;
const pngCache = new Map<string, RenderedPng>();
let pngBytes = 0;

export interface RenderedPng {
  png: Buffer;
  width: number;
  height: number;
  window: WindowChoice;
  /** Modality value range of the frame (grey only). */
  range: { min: number; max: number } | null;
  frames: number;
}

export function clearDicomCaches(): void {
  fileCache.clear();
  frameCache.clear();
  frameBytes = 0;
  pngCache.clear();
  pngBytes = 0;
}

onLockChange((unlocked) => {
  if (!unlocked) clearDicomCaches();
});

function touchLru<V>(map: Map<string, V>, key: string): V | undefined {
  const v = map.get(key);
  if (v !== undefined) {
    map.delete(key);
    map.set(key, v);
  }
  return v;
}

/** Decrypt and parse a document's file (small LRU, memory only). */
function parsedFile(doc: DicomDocument): ParsedDicom {
  const hit = touchLru(fileCache, doc.id);
  if (hit) return hit.parsed;
  const buffer = getFile(doc.storageKey);
  const parsed = parseDicomFile(buffer);
  if (buffer.length <= 256 * 1024 * 1024) {
    fileCache.set(doc.id, { parsed, bytes: buffer.length });
    let total = 0;
    for (const e of fileCache.values()) total += e.bytes;
    while (fileCache.size > FILE_CACHE_MAX || (total > FILE_CACHE_BYTES && fileCache.size > 1)) {
      const oldest = fileCache.keys().next().value as string;
      total -= fileCache.get(oldest)?.bytes ?? 0;
      fileCache.delete(oldest);
    }
  }
  return parsed;
}

interface IngestDicomMeta {
  patientName?: string;
  patientId?: string;
  studyDate?: string;
  studyTime?: string;
  seriesDate?: string;
  modality?: string;
  studyDescription?: string;
  seriesDescription?: string;
  institutionName?: string;
  bodyPartExamined?: string;
  accessionNumber?: string;
  rows?: number;
  columns?: number;
  numberOfFrames?: number;
  sopInstanceUid?: string;
  studyInstanceUid?: string;
  seriesInstanceUid?: string;
  transferSyntaxUid?: string;
}

function readMeta(doc: Pick<DicomDocument, 'metadataJson'>): { meta: Record<string, unknown>; ok: boolean } {
  try {
    const v = JSON.parse(doc.metadataJson || '{}') as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return { meta: v as Record<string, unknown>, ok: true };
  } catch {
    // fall through
  }
  return { meta: {}, ok: false };
}

/** What is known about a document without reading its file: the stored index, else the ingest tags. */
function storedIndex(doc: DicomDocument): { index: Partial<DicomIndex>; current: boolean } {
  const { meta } = readMeta(doc);
  const view = meta.dicomView as DicomIndex | undefined;
  if (view && typeof view === 'object' && view.v === DICOM_INDEX_VERSION) return { index: view, current: true };
  const m = (meta.dicom ?? {}) as IngestDicomMeta;
  return {
    index: compact<Partial<DicomIndex>>({
      studyUid: m.studyInstanceUid,
      seriesUid: m.seriesInstanceUid,
      sopUid: m.sopInstanceUid,
      modality: m.modality,
      studyDate: m.studyDate,
      studyTime: m.studyTime,
      seriesDate: m.seriesDate,
      studyDescription: m.studyDescription,
      seriesDescription: m.seriesDescription,
      bodyPart: m.bodyPartExamined,
      institution: m.institutionName,
      accession: m.accessionNumber,
      patientName: m.patientName,
      patientId: m.patientId,
      rows: m.rows,
      columns: m.columns,
      frames: m.numberOfFrames && m.numberOfFrames > 0 ? m.numberOfFrames : 1,
      transferSyntaxUid: m.transferSyntaxUid ?? undefined,
    }),
    current: false,
  };
}

function persistIndex(id: string, index: DicomIndex): void {
  try {
    db().transaction((tx) => {
      const row = tx.select({ metadataJson: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, id)).get();
      if (!row) return;
      const { meta, ok } = readMeta(row);
      // Unreadable metadata is left exactly as it is; the index is rebuilt next time instead.
      if (!ok) return;
      meta.dicomView = index;
      tx.update(schema.documents).set({ metadataJson: JSON.stringify(meta) }).where(eq(schema.documents.id, id)).run();
    });
  } catch (err) {
    console.error('[dicom] could not store the index for', id, err instanceof Error ? err.message : err);
  }
}

/** The full index of a document, reading (and remembering) its file when the stored one is missing or old. */
function ensureIndex(doc: DicomDocument): DicomIndex {
  const stored = storedIndex(doc);
  if (stored.current) return stored.index as DicomIndex;
  let index: DicomIndex;
  try {
    index = indexDataSet(parsedFile(doc));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // A file that could not be read or decrypted (locked by antivirus or a
    // backup, briefly missing, a locked case) is a passing condition: answer
    // with the error now and try again next time instead of remembering it.
    // Only a file that was read and is not valid DICOM is remembered.
    if (e?.code || err instanceof LockedError || /decrypt|auth(?:entication)? tag|unsupported state/i.test(e?.message ?? '')) {
      const passing: DicomIndex = { ...(stored.index as DicomIndex), v: DICOM_INDEX_VERSION, at: nowIso(), part10: false, transferSyntaxUid: stored.index.transferSyntaxUid ?? null, frames: stored.index.frames ?? 1, hasPixelData: false, encapsulated: false, error: `the file could not be read just now (${e?.code ?? 'read error'}); try again` };
      return passing;
    }
    const msg = (err instanceof Error ? err.message : String(err)).replace(/[A-Za-z]:\\[^\s'"]+|\/[^\s'"]*\/[^\s'"]+/g, '<file>');
    index = { ...(stored.index as DicomIndex), v: DICOM_INDEX_VERSION, at: nowIso(), part10: false, transferSyntaxUid: stored.index.transferSyntaxUid ?? null, frames: stored.index.frames ?? 1, hasPixelData: false, encapsulated: false, error: msg.slice(0, 300) };
  }
  persistIndex(doc.id, index);
  doc.metadataJson = JSON.stringify({ ...readMeta(doc).meta, dicomView: index });
  return index;
}

// ---------------------------------------------------------------------------
// Studies, series and instances
// ---------------------------------------------------------------------------

export interface DicomInstance {
  documentId: string;
  title: string;
  filename: string;
  sizeBytes: number;
  instanceNumber: number | null;
  sopUid: string | null;
  frames: number;
  rows: number | null;
  columns: number | null;
  sliceLocation: number | null;
  imagePosition: number[] | null;
  windowCenter: number | null;
  windowWidth: number | null;
  transferSyntaxUid: string | null;
  decodable: boolean;
  reason: string | null;
}

export interface DicomSeriesSummary {
  key: string;
  seriesUid: string | null;
  studyKey: string;
  number: number | null;
  description: string | null;
  modality: string | null;
  bodyPart: string | null;
  date: string | null;
  datePrecision: string;
  time: string | null;
  instanceCount: number;
  frameCount: number;
  firstDocumentId: string;
  rows: number | null;
  columns: number | null;
  transferSyntaxUid: string | null;
  transferSyntaxName: string;
  /** yes: every instance decodes; no: none does; some: mixed; unknown: not read yet. */
  decodable: 'yes' | 'no' | 'some' | 'unknown';
  reason: string | null;
}

export interface LinkedImagingStudy {
  id: string;
  title: string;
  modality: string;
  bodyPart: string | null;
  performedAt: string | null;
  performedAtPrecision: string;
  /** true: its dicomDocumentIds reference an instance of this study; false: same day, not linked. */
  linked: boolean;
  dicomDocumentIds: string[];
}

export interface LinkedRecord {
  id: string;
  title: string;
  status: string;
  recordType: string;
  format: string;
  held: boolean;
  /** true: the row's document is an instance of this study; false: a DICOM or images row of the same day. */
  linked: boolean;
}

export interface DicomStudySummary {
  key: string;
  studyUid: string | null;
  description: string | null;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  time: string | null;
  modalities: string[];
  institution: string | null;
  accession: string | null;
  patientName: string | null;
  patientId: string | null;
  seriesCount: number;
  instanceCount: number;
  series: DicomSeriesSummary[];
  imagingStudies: LinkedImagingStudy[];
  records: LinkedRecord[];
}

interface Indexed {
  doc: DicomDocument;
  ix: Partial<DicomIndex>;
  full: boolean;
}

const studyKeyOf = (x: Indexed) => x.ix.studyUid ?? `doc:${x.doc.id}`;
const seriesKeyOf = (x: Indexed) => (x.ix.seriesUid ? x.ix.seriesUid : x.ix.studyUid ? `${x.ix.studyUid}|noseries` : `doc:${x.doc.id}`);

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Instances in reading order: InstanceNumber, then (without one, or on a tie) the file name, then the id. */
export function compareInstances(a: { instanceNumber?: number | null; filename: string; id?: string }, b: { instanceNumber?: number | null; filename: string; id?: string }): number {
  const an = a.instanceNumber ?? null;
  const bn = b.instanceNumber ?? null;
  if (an !== null && bn !== null && an !== bn) return an - bn;
  if (an !== null && bn === null) return -1;
  if (an === null && bn !== null) return 1;
  return collator.compare(a.filename, b.filename) || (a.id ?? '').localeCompare(b.id ?? '');
}

function decodableOf(ix: Partial<DicomIndex>, full: boolean): { ok: boolean | null; reason: string | null } {
  if (!full) {
    // Only the transfer syntax is known before the file is read.
    if (ix.transferSyntaxUid && !isNativeSyntax(ix.transferSyntaxUid)) return { ok: false, reason: `not decodable in this build: ${transferSyntaxName(ix.transferSyntaxUid)}` };
    return { ok: null, reason: null };
  }
  const reason = undecodableReason(ix as DicomIndex);
  return { ok: reason === null, reason };
}

function partialDateOf(...das: Array<string | undefined>): { iso: string | null; precision: string; text: string | null } {
  for (const da of das) {
    const p = dicomDate(da);
    if (p?.iso) return { iso: p.iso, precision: p.precision, text: p.text };
  }
  return { iso: null, precision: 'unknown', text: null };
}

function toInstance(x: Indexed): DicomInstance {
  const d = decodableOf(x.ix, x.full);
  return {
    documentId: x.doc.id,
    title: x.doc.title,
    filename: x.doc.filename,
    sizeBytes: x.doc.sizeBytes,
    instanceNumber: x.ix.instanceNumber ?? null,
    sopUid: x.ix.sopUid ?? null,
    frames: x.ix.frames ?? 1,
    rows: x.ix.rows ?? null,
    columns: x.ix.columns ?? null,
    sliceLocation: x.ix.sliceLocation ?? null,
    imagePosition: x.ix.imagePosition ?? null,
    windowCenter: x.ix.windowCenter ?? null,
    windowWidth: x.ix.windowWidth ?? null,
    transferSyntaxUid: x.ix.transferSyntaxUid ?? null,
    decodable: d.ok !== false,
    reason: d.reason,
  };
}

function summariseSeries(key: string, members: Indexed[]): DicomSeriesSummary {
  const sorted = [...members].sort((a, b) => compareInstances({ ...a.ix, filename: a.doc.filename, id: a.doc.id }, { ...b.ix, filename: b.doc.filename, id: b.doc.id }));
  // Series-level attributes come from a file that was read when there is one (ingestion keeps no SeriesNumber).
  const first = sorted.find((m) => m.full) ?? sorted[0];
  const states = sorted.map((m) => decodableOf(m.ix, m.full));
  const yes = states.filter((s) => s.ok === true).length;
  const no = states.filter((s) => s.ok === false).length;
  // Files not read yet count as their read siblings: one transfer syntax per series is the norm.
  const decodable: DicomSeriesSummary['decodable'] = yes && no ? 'some' : yes ? 'yes' : no ? 'no' : 'unknown';
  const date = partialDateOf(first.ix.seriesDate, first.ix.studyDate);
  const syntaxes = [...new Set(sorted.map((m) => m.ix.transferSyntaxUid ?? null))];
  const ts = syntaxes.length === 1 ? syntaxes[0] : null;
  return {
    key,
    seriesUid: first.ix.seriesUid ?? null,
    studyKey: studyKeyOf(first),
    number: first.ix.seriesNumber ?? null,
    description: first.ix.seriesDescription ?? (first.ix.seriesUid ? null : first.doc.title),
    modality: first.ix.modality ?? null,
    bodyPart: first.ix.bodyPart ?? null,
    date: date.iso,
    datePrecision: date.precision,
    time: first.ix.seriesTime ?? first.ix.studyTime ?? null,
    instanceCount: sorted.length,
    frameCount: sorted.reduce((n, m) => n + (m.ix.frames ?? 1), 0),
    /** First in reading order as far as it is known (every file of the series is read by GET /series). */
    firstDocumentId: sorted[0].doc.id,
    rows: first.ix.rows ?? null,
    columns: first.ix.columns ?? null,
    transferSyntaxUid: ts,
    transferSyntaxName: syntaxes.length === 1 ? transferSyntaxName(ts) : `${syntaxes.length} transfer syntaxes`,
    decodable,
    reason: states.find((s) => s.reason)?.reason ?? null,
  };
}

function compareSeries(a: DicomSeriesSummary, b: DicomSeriesSummary): number {
  if (a.number !== null && b.number !== null && a.number !== b.number) return a.number - b.number;
  if (a.number !== null && b.number === null) return -1;
  if (a.number === null && b.number !== null) return 1;
  return (a.time ?? '').localeCompare(b.time ?? '') || collator.compare(a.description ?? '', b.description ?? '') || a.key.localeCompare(b.key);
}

function indexedDocuments(docs: DicomDocument[], read: (x: Indexed) => boolean): Indexed[] {
  return docs.map((doc) => {
    const s = storedIndex(doc);
    const x: Indexed = { doc, ix: s.index, full: s.current };
    if (!x.full && read(x)) {
      x.ix = ensureIndex(doc);
      x.full = true;
    }
    return x;
  });
}

/** Imaging studies and records rows that point at (or share the day of) each DICOM study. */
function linksFor(studies: Array<{ key: string; documentIds: Set<string>; date: string | null; datePrecision: string }>): Map<string, { imaging: LinkedImagingStudy[]; records: LinkedRecord[] }> {
  const out = new Map<string, { imaging: LinkedImagingStudy[]; records: LinkedRecord[] }>();
  if (!studies.length) return out;
  const imaging = db()
    .select({ id: schema.imagingStudies.id, title: schema.imagingStudies.title, modality: schema.imagingStudies.modality, bodyPart: schema.imagingStudies.bodyPart, performedAt: schema.imagingStudies.performedAt, performedAtPrecision: schema.imagingStudies.performedAtPrecision, dicom: schema.imagingStudies.dicomDocumentIdsJson })
    .from(schema.imagingStudies)
    .where(isNull(schema.imagingStudies.deletedAt))
    .all()
    .map((r) => ({ ...r, ids: parseJson<unknown[]>(r.dicom, []).filter((x): x is string => typeof x === 'string') }));
  const records = db()
    .select({ id: schema.recordsInventory.id, title: schema.recordsInventory.title, status: schema.recordsInventory.status, recordType: schema.recordsInventory.recordType, format: schema.recordsInventory.format, held: schema.recordsInventory.held, documentId: schema.recordsInventory.documentId, recordDate: schema.recordsInventory.recordDate })
    .from(schema.recordsInventory)
    .where(isNull(schema.recordsInventory.deletedAt))
    .all();
  for (const s of studies) {
    const sameDay = (iso: string | null) => Boolean(iso && s.date && s.datePrecision === 'day' && iso.slice(0, 10) === s.date);
    const im: LinkedImagingStudy[] = [];
    for (const r of imaging) {
      const linked = r.ids.some((id) => s.documentIds.has(id));
      if (linked || sameDay(r.performedAt)) im.push({ id: r.id, title: r.title, modality: r.modality, bodyPart: r.bodyPart, performedAt: r.performedAt, performedAtPrecision: r.performedAtPrecision, linked, dicomDocumentIds: r.ids });
    }
    const rec: LinkedRecord[] = [];
    for (const r of records) {
      const linked = Boolean(r.documentId && s.documentIds.has(r.documentId));
      const imagesRow = r.recordType === 'imaging_images' || r.recordType === 'dicom' || r.format === 'dicom';
      if (linked || (imagesRow && sameDay(r.recordDate))) rec.push({ id: r.id, title: r.title, status: r.status, recordType: r.recordType, format: r.format, held: Boolean(r.held), linked });
    }
    im.sort((a, b) => Number(b.linked) - Number(a.linked) || a.title.localeCompare(b.title));
    rec.sort((a, b) => Number(b.linked) - Number(a.linked) || a.title.localeCompare(b.title));
    out.set(s.key, { imaging: im, records: rec });
  }
  return out;
}

function buildStudies(items: Indexed[]): DicomStudySummary[] {
  const byStudy = new Map<string, Indexed[]>();
  for (const x of items) {
    const k = studyKeyOf(x);
    const list = byStudy.get(k);
    if (list) list.push(x);
    else byStudy.set(k, [x]);
  }
  const drafts = [...byStudy.entries()].map(([key, members]) => {
    const bySeries = new Map<string, Indexed[]>();
    for (const m of members) {
      const sk = seriesKeyOf(m);
      const list = bySeries.get(sk);
      if (list) list.push(m);
      else bySeries.set(sk, [m]);
    }
    const series = [...bySeries.entries()].map(([sk, ms]) => summariseSeries(sk, ms)).sort(compareSeries);
    const first = members.find((m) => m.ix.studyDescription) ?? members[0];
    const date = partialDateOf(first.ix.studyDate, first.ix.seriesDate);
    const fallbackDate = date.iso ? date : { iso: first.doc.documentDate, precision: first.doc.documentDatePrecision, text: null };
    const pick = (f: (x: Partial<DicomIndex>) => string | undefined) => members.map((m) => f(m.ix)).find(Boolean) ?? null;
    return {
      key,
      documentIds: new Set(members.map((m) => m.doc.id)),
      summary: {
        key,
        studyUid: first.ix.studyUid ?? null,
        description: first.ix.studyDescription ?? (first.ix.studyUid ? null : first.doc.title),
        date: fallbackDate.iso,
        datePrecision: fallbackDate.precision,
        dateText: date.text,
        time: first.ix.studyTime ?? null,
        modalities: [...new Set(members.map((m) => m.ix.modality).filter((x): x is string => Boolean(x)))].sort(),
        institution: pick((x) => x.institution),
        accession: pick((x) => x.accession),
        patientName: pick((x) => x.patientName),
        patientId: pick((x) => x.patientId),
        seriesCount: series.length,
        instanceCount: members.length,
        series,
        imagingStudies: [],
        records: [],
      } as DicomStudySummary,
    };
  });
  const links = linksFor(drafts.map((d) => ({ key: d.key, documentIds: d.documentIds, date: d.summary.date, datePrecision: d.summary.datePrecision })));
  const out = drafts.map((d) => ({ ...d.summary, imagingStudies: links.get(d.key)?.imaging ?? [], records: links.get(d.key)?.records ?? [] }));
  // Newest study first; undated last.
  out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || (b.time ?? '').localeCompare(a.time ?? '') || collator.compare(a.description ?? '', b.description ?? '') || a.key.localeCompare(b.key));
  return out;
}

/** At most this many files are read by one studies listing (documents that ingestion could not tag). */
const LISTING_READ_LIMIT = 50;
/** At most this many series are sampled (one file each) by one studies listing. */
const SERIES_SAMPLE_LIMIT = 200;

/**
 * Ingestion does not keep SeriesNumber, series time or the pixel layout, so a
 * series none of whose files was read yet would sort by description and say
 * "unknown". One file per such series is read (the one whose name sorts
 * first) and its index stored: series-level attributes are the same in every
 * instance, and the next listing reads nothing.
 */
function sampleSeries(items: Indexed[]): void {
  const bySeries = new Map<string, Indexed[]>();
  for (const x of items) {
    const k = seriesKeyOf(x);
    const list = bySeries.get(k);
    if (list) list.push(x);
    else bySeries.set(k, [x]);
  }
  let sampled = 0;
  for (const members of bySeries.values()) {
    if (members.some((m) => m.full)) continue;
    if (sampled++ >= SERIES_SAMPLE_LIMIT) break;
    const pick = members.reduce((a, b) => (collator.compare(b.doc.filename, a.doc.filename) < 0 ? b : a));
    pick.ix = ensureIndex(pick.doc);
    pick.full = true;
  }
}

/** Every DICOM study on file, grouped by StudyInstanceUID, with series and instance counts and linked records. */
export function listDicomStudies(opts: { q?: string } = {}): { items: DicomStudySummary[]; total: number; instances: number } {
  let reads = 0;
  // Documents with no UIDs at all (ingestion failed to tag them) are read once so they group correctly.
  const items = indexedDocuments(liveDicomDocuments(), (x) => !x.ix.studyUid && !x.ix.seriesUid && reads++ < LISTING_READ_LIMIT);
  sampleSeries(items);
  let studies = buildStudies(items);
  const q = opts.q?.trim().toLowerCase();
  if (q) {
    studies = studies.filter((s) =>
      [s.description, s.date, s.institution, s.accession, s.patientName, s.studyUid, ...s.modalities, ...s.series.flatMap((x) => [x.description, x.modality, x.bodyPart])]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }
  return { items: studies, total: studies.length, instances: items.length };
}

/** One series (by SeriesInstanceUID or `doc:<id>` key): its instances in reading order, each file indexed. */
export function getDicomSeries(key: string, retried = false): { series: DicomSeriesSummary; study: Omit<DicomStudySummary, 'series'>; instances: DicomInstance[] } {
  const all = indexedDocuments(liveDicomDocuments(), () => false);
  const members = all.filter((x) => seriesKeyOf(x) === key);
  if (!members.length) throw notFound('series not found');
  for (const m of members) {
    if (!m.full) {
      m.ix = ensureIndex(m.doc);
      m.full = true;
    }
  }
  // Reading a file can give it the UIDs ingestion missed (a `doc:` key): answer for the series it really belongs to.
  const here = members.filter((x) => seriesKeyOf(x) === key);
  if (!here.length) {
    if (!retried) return getDicomSeries(seriesKeyOf(members[0]), true);
    throw notFound('series not found');
  }
  const studyKey = studyKeyOf(here[0]);
  const studyMembers = all.filter((x) => studyKeyOf(x) === studyKey && !here.includes(x)).concat(here);
  const study = buildStudies(studyMembers).find((s) => s.key === studyKey);
  if (!study) throw notFound('study not found');
  const series = study.series.find((s) => s.key === key) ?? summariseSeries(key, here);
  const instances = here
    .slice()
    .sort((a, b) => compareInstances({ ...a.ix, filename: a.doc.filename, id: a.doc.id }, { ...b.ix, filename: b.doc.filename, id: b.doc.id }))
    .map(toInstance);
  const { series: _omit, ...studyRest } = study;
  return { series, study: studyRest, instances };
}

export interface DicomInstanceDetail extends DicomInstance {
  seriesKey: string;
  studyKey: string;
  modality: string | null;
  seriesDescription: string | null;
  studyDescription: string | null;
  sopClassUid: string | null;
  part10: boolean;
  transferSyntaxName: string;
  photometric: string | null;
  samplesPerPixel: number | null;
  bitsAllocated: number | null;
  bitsStored: number | null;
  pixelRepresentation: number | null;
  rescaleSlope: number | null;
  rescaleIntercept: number | null;
  rescaleType: string | null;
  windowExplanation: string | null;
  voiLutFunction: string | null;
  pixelSpacing: number[] | null;
  sliceThickness: number | null;
  spacingBetweenSlices: number | null;
  /** The window frame 1 opens with when nothing is requested, and the frame's value range (grey, decodable only). */
  defaultWindow: { center: number; width: number; source: WindowChoice['source'] } | null;
  range: { min: number; max: number } | null;
  warnings: string[];
}

/** One instance: its index, how it decodes and the window it opens with. */
export function getDicomInstance(documentId: string): DicomInstanceDetail {
  const doc = dicomDocumentOr404(documentId);
  const ix = ensureIndex(doc);
  const x: Indexed = { doc, ix, full: true };
  let defaultWindow: DicomInstanceDetail['defaultWindow'] = null;
  let range: DicomInstanceDetail['range'] = null;
  if (!undecodableReason(ix)) {
    try {
      const frame = frameFor(doc, 0);
      const w = chooseWindow(ix, frame);
      defaultWindow = w.source === 'none' ? null : { center: w.center, width: w.width, source: w.source };
      range = frame.kind === 'gray' ? modalityRange(frame) : null;
    } catch {
      // The frame endpoint reports why; the detail still answers.
    }
  }
  return {
    ...toInstance(x),
    seriesKey: seriesKeyOf(x),
    studyKey: studyKeyOf(x),
    modality: ix.modality ?? null,
    seriesDescription: ix.seriesDescription ?? null,
    studyDescription: ix.studyDescription ?? null,
    sopClassUid: ix.sopClassUid ?? null,
    part10: ix.part10,
    transferSyntaxName: transferSyntaxName(ix.transferSyntaxUid),
    photometric: ix.photometric ?? null,
    samplesPerPixel: ix.samplesPerPixel ?? null,
    bitsAllocated: ix.bitsAllocated ?? null,
    bitsStored: ix.bitsStored ?? null,
    pixelRepresentation: ix.pixelRepresentation ?? null,
    rescaleSlope: ix.rescaleSlope ?? null,
    rescaleIntercept: ix.rescaleIntercept ?? null,
    rescaleType: ix.rescaleType ?? null,
    windowExplanation: ix.windowExplanation ?? null,
    voiLutFunction: ix.voiLutFunction ?? null,
    pixelSpacing: ix.pixelSpacing ?? null,
    sliceThickness: ix.sliceThickness ?? null,
    spacingBetweenSlices: ix.spacingBetweenSlices ?? null,
    defaultWindow,
    range,
    warnings: ix.warnings ?? [],
  };
}

/** Every element of one instance, in tag order, with names from the built-in dictionary. */
export function getDicomTags(documentId: string): DicomTag[] {
  const doc = dicomDocumentOr404(documentId);
  return listTags(parsedFile(doc).ds);
}

function frameFor(doc: DicomDocument, frameIndex: number): DecodedFrame {
  const key = `${doc.id}:${frameIndex}`;
  const hit = touchLru(frameCache, key);
  if (hit) return hit;
  const frame = decodeFrame(parsedFile(doc), frameIndex);
  frameCache.set(key, frame);
  frameBytes += frame.bytes;
  while (frameBytes > FRAME_CACHE_BYTES && frameCache.size > 1) {
    const oldest = frameCache.keys().next().value as string;
    frameBytes -= frameCache.get(oldest)?.bytes ?? 0;
    frameCache.delete(oldest);
  }
  return frame;
}

export interface FrameRequest {
  wc?: number;
  ww?: number;
  scale?: number;
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/** Frame `frameNumber` (1-based) of a DICOM document as a PNG, windowed and scaled (LRU, memory only). */
export function renderDicomFrame(documentId: string, frameNumber: number, req: FrameRequest = {}): RenderedPng {
  const doc = dicomDocumentOr404(documentId);
  const ix = ensureIndex(doc);
  assertDecodable(ix);
  if (!Number.isInteger(frameNumber) || frameNumber < 1 || frameNumber > ix.frames) throw notFound(`frame ${frameNumber} does not exist (this instance has ${ix.frames})`);
  const scale = round(Math.min(4, Math.max(0.05, req.scale ?? 1)), 3);
  const wc = req.wc === undefined ? undefined : round(req.wc);
  const ww = req.ww === undefined ? undefined : round(Math.max(req.ww, 1e-6));
  const key = `${doc.id}:${frameNumber}:${wc ?? ''}:${ww ?? ''}:${scale}`;
  const hit = touchLru(pngCache, key);
  if (hit) return hit;
  const frame = frameFor(doc, frameNumber - 1);
  const window = chooseWindow(ix, frame, { wc, ww });
  const img = renderFrame(frame, window, scale);
  const out: RenderedPng = { png: encodePng(img), width: img.width, height: img.height, window, range: frame.kind === 'gray' ? modalityRange(frame) : null, frames: ix.frames };
  pngCache.set(key, out);
  pngBytes += out.png.length;
  while ((pngBytes > PNG_CACHE_BYTES || pngCache.size > PNG_CACHE_MAX) && pngCache.size > 1) {
    const oldest = pngCache.keys().next().value as string;
    pngBytes -= pngCache.get(oldest)?.png.length ?? 0;
    pngCache.delete(oldest);
  }
  return out;
}
