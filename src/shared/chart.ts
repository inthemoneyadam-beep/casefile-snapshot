/**
 * Chart specification shared by the server (the consult's chart tool, lab and
 * symptom series endpoints) and the client renderer
 * (src/client/features/charts/LineChart.tsx). Keep it data-only.
 */
import { z } from 'zod';

export const chartTone = z.enum(['accent', 'warn', 'bad', 'ok', 'ash', 'info']);
export type ChartTone = z.infer<typeof chartTone>;

export const chartPoint = z.object({
  x: z.union([z.string(), z.number()]).describe('ISO date (YYYY, YYYY-MM or YYYY-MM-DD), a number, or a category label'),
  y: z.number().nullable().describe('null leaves a gap in the line'),
  label: z.string().nullable().optional(),
  /**
   * Lab charts (2026-10): "H", "L", "A" or "C" is the flag printed with the value (the report flagged it); "H~" or "L~"
   * is outside the range printed with it, worked out by the app (no flag printed); no "N". A summary's or a note's own
   * flag never reaches a point (it is that document's claim, rules 11 and 12).
   */
  flag: z.string().nullable().optional().describe('H, L, A or C marks the point as out of range (the report flagged it); H~ or L~: outside its own range, worked out'),
  href: z.string().nullable().optional().describe('Link to the source (e.g. /documents/<id>?page=3)'),
  /** Lab charts (2026-10-09): 'square' is a value computed by the patient (src/shared/labcompute.ts), drawn as an open square, never red. */
  marker: z.enum(['square']).nullable().optional(),
});
export type ChartPoint = z.infer<typeof chartPoint>;

export const chartSeries = z.object({
  name: z.string(),
  unit: z.string().nullable().optional(),
  kind: z.enum(['line', 'bar', 'scatter']).nullable().optional(),
  points: z.array(chartPoint),
});
export type ChartSeries = z.infer<typeof chartSeries>;

export const chartBand = z.object({
  from: z.union([z.string(), z.number()]),
  to: z.union([z.string(), z.number()]).nullable().describe('null means open-ended (to the right edge)'),
  label: z.string(),
  tone: chartTone.nullable().optional(),
  // Optional, for bands that stand for courses (medications). Charts without them draw every band as before.
  lane: z.string().optional().describe('Bands with the same lane share one row (one drug under two names)'),
  startKnown: z.boolean().optional().describe('false: the start was never stated; `from` is when it was first seen, or the left edge'),
  ongoing: z.boolean().optional().describe('true: no stop yet; the band runs to the right edge'),
  clippedStart: z.boolean().optional().describe('true: it began before the chart\'s first day; `from` is the left edge'),
  clippedEnd: z.boolean().optional().describe('true: it ends after the chart\'s last day; `to` is the right edge'),
});
export type ChartBand = z.infer<typeof chartBand>;

export const chartMarker = z.object({
  x: z.union([z.string(), z.number()]),
  label: z.string(),
  tone: chartTone.nullable().optional(),
});
export type ChartMarker = z.infer<typeof chartMarker>;

export const chartSpec = z.object({
  type: z.enum(['line', 'bar', 'scatter']),
  title: z.string().nullable().optional(),
  subtitle: z.string().nullable().optional(),
  xType: z.enum(['date', 'number', 'category']),
  xLabel: z.string().nullable().optional(),
  yLabel: z.string().nullable().optional(),
  series: z.array(chartSeries).min(1).max(8),
  referenceBand: z
    .object({ low: z.number().nullable(), high: z.number().nullable(), label: z.string().nullable().optional() })
    .nullable()
    .optional()
    .describe('Reference range shaded behind the data'),
  /**
   * A range the patient typed for a computed test (2026-10-09): drawn as dashed lines, labelled ("range typed by you"),
   * never shaded as the lab's band and never making a point red.
   */
  typedRange: z.object({ low: z.number().nullable(), high: z.number().nullable(), label: z.string() }).nullable().optional(),
  yDomain: z.union([z.tuple([z.number(), z.number()]), z.literal('auto')]).nullable().optional(),
  bands: z.array(chartBand).nullable().optional().describe('Shaded periods, e.g. a medication course'),
  markers: z.array(chartMarker).nullable().optional().describe('Vertical event ticks, e.g. an infusion or a procedure'),
  source: z.enum(['db', 'model']).nullable().optional().describe('db = built from stored rows; model = assembled by the model from retrieved text'),
  note: z.string().nullable().optional(),
});
export type ChartSpec = z.infer<typeof chartSpec>;

/** Convert an x value to a sortable number given the axis type. Partial dates pad to the first day. */
export function chartX(x: string | number, xType: ChartSpec['xType'], categories?: string[]): number {
  if (xType === 'number') return typeof x === 'number' ? x : Number(x);
  if (xType === 'category') {
    const i = categories?.indexOf(String(x)) ?? -1;
    return i;
  }
  if (typeof x === 'number') return x;
  const m = x.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), m[2] ? Number(m[2]) - 1 : 0, m[3] ? Number(m[3]) : 1);
}
