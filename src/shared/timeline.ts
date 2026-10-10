/**
 * Timeline types shared by the API and the client. The timeline is not a
 * table: it is a union over every dated entity, each tagged with its kind.
 */
import type { DatePrecision } from './dates';

export const TIMELINE_KINDS = [
  'document',
  'fact',
  'communication',
  'encounter',
  'medication_event',
  'lab',
  'imaging',
  'symptom',
  'daily',
  'task',
  'finding',
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/**
 * Each kind in the app's words (2026-10 UI rollout), never the stored kind ("fact", "contact", "encounter"): a group,
 * a filter choice or a packet's list of kinds. The Timeline page, Make a packet and the packet itself all use these.
 */
export const TIMELINE_KIND_LABELS: Record<TimelineKind, string> = {
  document: 'Documents',
  fact: 'Details',
  communication: 'Calls and messages',
  encounter: 'Appointments',
  medication_event: 'Medication changes',
  lab: 'Lab results',
  imaging: 'Scans',
  symptom: 'Symptom scores',
  daily: 'Diary days',
  task: 'To-dos',
  finding: 'What Claude noticed',
};

/** One item of a kind (a row's kind, a pane's eyebrow). */
export const TIMELINE_KIND_ONE: Record<TimelineKind, string> = {
  document: 'Document',
  fact: 'Detail',
  communication: 'Call or message',
  encounter: 'Appointment',
  medication_event: 'Medication change',
  lab: 'Lab result',
  imaging: 'Scan',
  symptom: 'Symptom scores',
  daily: 'Diary day',
  task: 'To-do',
  finding: 'Finding',
};

export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  /** YYYY, YYYY-MM or YYYY-MM-DD. Undated rows are never returned. */
  date: string;
  datePrecision: DatePrecision;
  title: string;
  detail?: string | null;
  status?: string | null;
  href: string;
  subKind?: string | null;
  personName?: string | null;
  documentId?: string | null;
}

export type TimelineBucket = 'year' | 'month' | 'day';
export type TimelineZoom = 'years' | 'months' | 'days';

export interface TimelineResponse {
  items: TimelineItem[];
  range: { min: string | null; max: string | null };
  /** Per-kind counts over the filtered set plus `undated`, the rows excluded for having no date. */
  counts: Record<string, number>;
}

export interface TimelineDensityRow {
  bucket: string;
  counts: Record<string, number>;
}

export interface TimelineDensityResponse {
  bucket: TimelineBucket;
  items: TimelineDensityRow[];
}

export function isTimelineKind(s: string): s is TimelineKind {
  return (TIMELINE_KINDS as readonly string[]).includes(s);
}

/** A composite key, unique across kinds (symptom and daily rows are keyed by date). */
export function timelineKey(item: Pick<TimelineItem, 'kind' | 'id'>): string {
  return `${item.kind}:${item.id}`;
}
