/**
 * Typed client for /api/dicom (slice N, the DICOM viewer). Query keys all
 * start with 'dicom'. Frames are fetched as blobs (not plain <img src>) so the
 * viewer can read the window the server applied from the response headers,
 * show the 415 reason for a compressed file, and keep a small in-memory cache
 * of object URLs for smooth scrolling; the cache is emptied on lock.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, ApiError, LOCK_EVENT } from './client';

export type Decodable = 'yes' | 'no' | 'some' | 'unknown';

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
  decodable: Decodable;
  reason: string | null;
}

export interface LinkedImagingStudy {
  id: string;
  title: string;
  modality: string;
  bodyPart: string | null;
  performedAt: string | null;
  performedAtPrecision: string;
  /** true: it references an instance of this study; false: same day, not linked. */
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

export interface DicomSeriesDetail {
  series: DicomSeriesSummary;
  study: Omit<DicomStudySummary, 'series'>;
  instances: DicomInstance[];
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
  defaultWindow: { center: number; width: number; source: 'request' | 'file' | 'computed' | 'none' } | null;
  range: { min: number; max: number } | null;
  warnings: string[];
}

export interface DicomTag {
  tag: string;
  vr: string | null;
  name: string;
  value: string;
  depth: number;
  private: boolean;
}

export const dicomKeys = {
  all: ['dicom'] as const,
  studies: (q: string) => ['dicom', 'studies', q] as const,
  series: (key: string) => ['dicom', 'series', key] as const,
  instance: (id: string) => ['dicom', 'instance', id] as const,
  tags: (id: string) => ['dicom', 'tags', id] as const,
};

const enc = encodeURIComponent;

export function useDicomStudies(q = '') {
  return useQuery({ queryKey: dicomKeys.studies(q), queryFn: () => api.get<{ items: DicomStudySummary[]; total: number; instances: number }>(`/api/dicom/studies${api.qs({ q })}`), staleTime: 30_000 });
}

/** One series with every instance in reading order; also used with queryClient.fetchQuery before opening a series. */
export function seriesQuery(key: string) {
  return { queryKey: dicomKeys.series(key), queryFn: () => api.get<DicomSeriesDetail>(`/api/dicom/series/${enc(key)}`), staleTime: 60_000, retry: false } as const;
}

export function useDicomSeries(key: string | null) {
  return useQuery({ ...seriesQuery(key ?? ''), enabled: Boolean(key) });
}

export function useDicomInstance(id: string | null) {
  return useQuery({ queryKey: dicomKeys.instance(id ?? ''), queryFn: () => api.get<DicomInstanceDetail>(`/api/dicom/instances/${enc(id ?? '')}`), enabled: Boolean(id), staleTime: 60_000, retry: false, placeholderData: keepPreviousData });
}

export function useDicomTags(id: string | null, enabled: boolean) {
  return useQuery({ queryKey: dicomKeys.tags(id ?? ''), queryFn: () => api.get<{ items: DicomTag[]; total: number }>(`/api/dicom/instances/${enc(id ?? '')}/tags`), enabled: Boolean(id) && enabled, staleTime: 5 * 60_000, retry: false, placeholderData: keepPreviousData });
}

/** The original file, as a download (the server sends it as an attachment). */
export function originalUrl(documentId: string): string {
  return `/api/documents/${enc(documentId)}/file?download=1`;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export interface FrameRequest {
  documentId: string;
  /** 1-based. */
  frame: number;
  wc?: number;
  ww?: number;
  scale?: number;
}

export interface FrameImage {
  url: string;
  width: number;
  height: number;
  /** The window the server applied, and where it came from. */
  window: { center: number; width: number; source: string } | null;
  /** Modality value range of the frame (grey only). */
  range: { min: number; max: number } | null;
  frames: number;
}

/** Why a frame cannot be shown (415 for a compressed syntax), from the server's JSON body. */
export interface FrameRefusal {
  error: string;
  reason?: 'compressed' | 'photometric' | 'bits';
  transferSyntaxName?: string;
  download?: string;
}

export function frameKey(r: FrameRequest): string {
  return `${r.documentId}|${r.frame}|${r.wc ?? ''}|${r.ww ?? ''}|${r.scale ?? 1}`;
}

export function frameUrl(r: FrameRequest): string {
  return `/api/dicom/instances/${enc(r.documentId)}/frame/${r.frame}.png${api.qs({ wc: r.wc, ww: r.ww, scale: r.scale && r.scale !== 1 ? r.scale : undefined })}`;
}

const CACHE_MAX = 48;
const cache = new Map<string, FrameImage>();
const inflight = new Map<string, Promise<FrameImage>>();

function evict(): void {
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value as string;
    const hit = cache.get(oldest);
    cache.delete(oldest);
    if (hit) URL.revokeObjectURL(hit.url);
  }
}

/** Drop every decoded image held in the page (on lock, and when the viewer unmounts). */
export function clearFrameCache(): void {
  for (const f of cache.values()) URL.revokeObjectURL(f.url);
  cache.clear();
  inflight.clear();
}

if (typeof window !== 'undefined') window.addEventListener(LOCK_EVENT, clearFrameCache);

const num = (v: string | null): number | null => {
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A frame already fetched, if any (no request). */
export function cachedFrame(r: FrameRequest): FrameImage | null {
  const key = frameKey(r);
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

/**
 * Fetch one frame as a PNG object URL (cached, de-duplicated while in flight).
 * A refusal throws ApiError whose body is a FrameRefusal.
 */
export function loadFrame(r: FrameRequest): Promise<FrameImage> {
  const hit = cachedFrame(r);
  if (hit) return Promise.resolve(hit);
  const key = frameKey(r);
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    const res = await fetch(frameUrl(r), { credentials: 'same-origin' });
    if (res.status === 423 || res.status === 401) window.dispatchEvent(new CustomEvent(LOCK_EVENT));
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let body: FrameRefusal = { error: `${res.status} ${res.statusText}` };
      try {
        body = JSON.parse(text) as FrameRefusal;
      } catch {
        // not JSON
      }
      throw new ApiError(res.status, body.error, body);
    }
    const blob = await res.blob();
    const size = (res.headers.get('x-dicom-size') ?? '').split('x').map(Number);
    const wc = num(res.headers.get('x-dicom-wc'));
    const ww = num(res.headers.get('x-dicom-ww'));
    const source = res.headers.get('x-dicom-window') ?? 'none';
    const min = num(res.headers.get('x-dicom-min'));
    const max = num(res.headers.get('x-dicom-max'));
    const img: FrameImage = {
      url: URL.createObjectURL(blob),
      width: size[0] || 0,
      height: size[1] || 0,
      window: source !== 'none' && wc !== null && ww !== null ? { center: wc, width: ww, source } : null,
      range: min !== null && max !== null ? { min, max } : null,
      frames: num(res.headers.get('x-dicom-frames')) ?? 1,
    };
    cache.set(key, img);
    evict();
    return img;
  })();
  inflight.set(key, p);
  void p.then(
    () => inflight.delete(key),
    () => inflight.delete(key),
  );
  return p;
}

/** Warm the cache for frames the user is likely to show next; failures are ignored (the frame itself reports them). */
export function prefetchFrames(list: FrameRequest[]): void {
  for (const r of list) {
    if (cache.has(frameKey(r)) || inflight.has(frameKey(r))) continue;
    loadFrame(r).catch(() => undefined);
  }
}
