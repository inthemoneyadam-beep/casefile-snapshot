/**
 * How the History view (MedicationGantt) reads a course's start: the recorded start, or,
 * when the start was never stated (a list or note only named the drug), the first date the records mention it.
 * Plain TypeScript (no React, no DOM), so tests can run it under node.
 *
 * The words are the symptom chart's (charts/lanes.ts courseWords): "taking since 2025-06-02",
 * "taking; on your list since 2026-10-04 (start date not recorded)", "stopped 2025-06-16 (start date not recorded)",
 * "taken 2025-06-02 to 2025-06-16".
 */
import { chartX } from '@shared/chart';
import { courseWords } from '../charts/lanes';

export interface CourseInput {
  /** The stored start. Read it with startRecorded: it may be only the date a list mentioned the drug. */
  start: string | null;
  stop: string | null;
  /** False when the start was never stated. Absent from an older server: a stored start then counts as recorded. */
  startRecorded?: boolean;
  /** The earliest date the records mention the drug. */
  firstSeen?: string | null;
  /** The status is a current one (active, prn, planned). */
  current: boolean;
}

export interface CourseReading {
  /** Where the course is drawn from: the recorded start, else the first mention; null when neither is known. */
  from: string | null;
  /** `from` is a recorded start (drawn solid); false draws it dashed, "start not recorded". */
  startRecorded: boolean;
  stop: string | null;
  /** Still taking: no stop date and a current status. */
  ongoing: boolean;
  /** The course in plain words, or null when the records date nothing about it. */
  words: string | null;
}

const at = (d: string) => chartX(d, 'date');

export function readCourse(c: CourseInput): CourseReading {
  const recorded = c.startRecorded !== false && Boolean(c.start);
  let from = recorded ? c.start : (c.firstSeen ?? (c.startRecorded === false ? c.start : null) ?? null);
  // A first mention on or after the stop (the note that says it was stopped, or a later one) says nothing about when
  // it ran: only the stop is known, drawn as a stub ending there.
  if (!recorded && from && c.stop && Number.isFinite(at(from)) && Number.isFinite(at(c.stop)) && at(from) >= at(c.stop)) from = null;
  const ongoing = !c.stop && c.current;
  let words: string | null = null;
  if (from) words = courseWords({ from, to: c.stop, startKnown: recorded, ongoing });
  else if (c.stop) words = courseWords({ from: c.stop, to: c.stop, startKnown: false, ongoing: false, firstSeen: null });
  return { from, startRecorded: recorded, stop: c.stop, ongoing, words };
}
