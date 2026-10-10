/**
 * Person × topic pivot for the communications matrix. Pure (no React) so it
 * can be unit tested. Row totals and topic totals come from the server's
 * distinct-communication rollups: summing cells would count a communication
 * once per topic in a person's Total/Open, and once per participant in a
 * topic's total.
 */
import type { MatrixCell, MatrixData } from '../../api/communications';

/** The URL value (and the server's) for calls and messages with no topic. */
export const NO_TOPIC = '(none)';
/** How no topic reads on screen. */
export const NO_TOPIC_WORDS = 'No topic';

/** A topic as it reads on screen: the topic itself, or "No topic". */
export function topicWords(topic: string | null | undefined): string {
  return !topic || topic === NO_TOPIC ? NO_TOPIC_WORDS : topic;
}

export interface MatrixRow {
  personId: string;
  name: string;
  total: number;
  open: number;
  lastAt: string | null;
  byTopic: Map<string, MatrixCell>;
}

export interface MatrixPivot {
  rows: MatrixRow[];
  topics: Array<{ topic: string; total: number }>;
}

/** Flat cells + rollups -> one row per person, one column per topic (most-used topics first, no-topic last). */
export function pivot(data: Pick<MatrixData, 'items' | 'people' | 'topics'>): MatrixPivot {
  const rows = new Map<string, MatrixRow>();
  for (const p of data.people) {
    rows.set(p.personId, { personId: p.personId, name: p.name, total: p.count, open: p.openFollowUps, lastAt: p.lastAt, byTopic: new Map() });
  }
  for (const c of data.items) rows.get(c.personId)?.byTopic.set(c.topic, c);
  const topics = data.topics
    .map((t) => ({ topic: t.topic, total: t.count }))
    .sort((a, b) => (a.topic === '' ? 1 : b.topic === '' ? -1 : 0) || b.total - a.total || a.topic.localeCompare(b.topic));
  return { rows: [...rows.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)), topics };
}
