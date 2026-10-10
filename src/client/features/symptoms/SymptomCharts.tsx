/**
 * The chart view body: the symptom ChartSpec and the sleep ChartSpec from GET /api/symptoms/series rendered with the
 * shared LineChart, each under a readable header that says what its scale means, plus a plain list of the
 * medications in the window and the event marks the chart draws, each linked to the record it stands for (the
 * medication, or the appointment), so nothing on the chart is unexplained or unverifiable.
 *
 * Nothing is drawn empty: with no score and no sleep in the window there are no axes, only `empty` (what to do next)
 * and the medication list in words. A chart with nothing to draw is a line of words instead. Symptoms with no score
 * in the window are named once rather than listed in the legend with nothing beside them.
 *
 * Medications are rows under the symptom chart (LineChart's lanes); the sleep chart over the same window carries only
 * the faint start and stop guides so the rows are not repeated. The list follows the rows' order and says each course
 * in plain words (lanes.ts courseWords), from the true dates. The two charts share one x range and one left column
 * (stackedChartAlign), so a date sits at the same x in both and the guides line up with the rows above.
 */
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { ChartSpec } from '@shared/chart';
import { todayIso } from '@shared/dates';
import { Section } from '../../ui/PageHeader';
import { LineChart } from '../charts/LineChart';
import { courseWords, laneOrder, stackedChartAlign } from '../charts/lanes';
import type { SeriesResponse } from '../../api/symptoms';

export interface SymptomChartsProps {
  data: SeriesResponse | undefined;
  loading: boolean;
  error: string | null;
  onOpenPoint: (x: string) => void;
  /** Width the charts draw at until they have measured their box (server rendering, tests). */
  initialWidth?: number;
  /** Shown instead of the charts when nothing was logged in the window: what to do next, with its buttons. */
  empty?: ReactNode;
  /** The symptom choices (shown above the symptom chart). */
  toggles?: ReactNode;
}

/** How the rows under the chart are drawn, said once above the list. */
export const LANES_KEY =
  'Each medication is a row under the chart: solid from its recorded start, dashed where only a mention date is known, an arrow if you are still taking it, an end mark where it stopped, a diamond for a single day. Faint vertical lines on the charts mark recorded starts and stops.';

function pointX(spec: ChartSpec, si: number, pi: number): string | null {
  const p = spec.series[si]?.points[pi];
  return p ? String(p.x) : null;
}

const points = (spec: ChartSpec) => spec.series.reduce((n, s) => n + s.points.length, 0);
const weeklyWords = (weekly: boolean) => (weekly ? 'Each point is the average of a week.' : '');
const unscoredWords = (names: string[]) => (names.length ? `Not scored in this window: ${names.join(', ')}.` : '');

export function SymptomCharts({ data, loading, error, onOpenPoint, initialWidth, empty, toggles }: SymptomChartsProps) {
  if (error) return <p className="loading-line">Could not load the chart: {error}</p>;
  if (!data) return <p className="loading-line">{loading ? 'Loading the chart…' : 'Nothing to chart.'}</p>;
  const symPoints = points(data.chart);
  const sleepPoints = points(data.sleep);
  const bands = laneOrder(data.overlays?.bands ?? []);
  const markers = data.overlays?.markers ?? [];
  const today = todayIso();
  // The symptom chart carries the medication rows: drawn when it has scores, or when there is sleep to line the rows up with.
  const showSymptoms = symPoints > 0 || (sleepPoints > 0 && bands.length > 0);
  const showSleep = sleepPoints > 0;
  // Only the symptoms scored in the window go in the legend; the others are named once under the header.
  const scored = data.chart.series.filter((s) => s.points.length > 0);
  const unscored = data.chart.series.filter((s) => s.points.length === 0 && s.name !== 'No symptoms defined').map((s) => s.name);
  const symptomSpec: ChartSpec = { ...data.chart, title: null, subtitle: null, yLabel: '0 = none, 10 = the worst', series: scored };
  const symIntro = [weeklyWords(data.bucket === 'week'), 'Click a point to open that day in the diary.', symPoints === 0 ? 'No symptom was scored in this window.' : unscoredWords(unscored)].filter(Boolean).join(' ');
  const sleepSpec: ChartSpec = { ...data.sleep, title: null, subtitle: null, series: data.sleep.series.filter((s) => s.points.length > 0) };
  const align = stackedChartAlign([symptomSpec, sleepSpec]);
  const weekly = data.bucket === 'week';
  const open = (spec: ChartSpec) => (si: number, pi: number) => {
    const x = pointX(spec, si, pi);
    if (x) onOpenPoint(x);
  };
  return (
    <div className="sym-charts">
      {toggles}
      {!showSymptoms && !showSleep ? empty : null}
      {showSymptoms ? (
        <Section
          title="Symptom scores"
          count={symPoints || undefined}
          intro={symIntro}
        >
          <figure className="sym-figure" aria-label="Symptom scores over time, with your medications as rows under the chart">
            <LineChart spec={symptomSpec} height={320} onPointClick={open(symptomSpec)} moreLanesNote="listed below" xRange={align.xRange} labelWidth={align.labelWidth} initialWidth={initialWidth} />
          </figure>
        </Section>
      ) : null}
      {showSleep ? (
        <Section title="Sleep and energy" intro={<>Bars: hours of sleep. Lines: sleep quality (0 = worst, 10 = best) and energy (0 = none, 10 = full){weekly ? '; each point is the average of a week' : ''}.</>}>
          <figure className="sym-figure" aria-label="Sleep hours, sleep quality and energy over time">
            <LineChart spec={sleepSpec} height={200} onPointClick={open(sleepSpec)} bandMode="guides" xRange={align.xRange} labelWidth={align.labelWidth} initialWidth={initialWidth} />
          </figure>
        </Section>
      ) : showSymptoms ? (
        <p className="sym-prose">No sleep or energy written down in this window.</p>
      ) : null}
      <div className="sym-overlays">
        <Section title="Medications in this window" count={bands.length || undefined}>
          {bands.length ? (
            <>
              {showSymptoms ? <p className="sym-lanes-key">{LANES_KEY}</p> : null}
              <ul className="sym-overlay-list">
                {bands.map((b, i) => (
                  <li key={`${b.medicationId}-${i}`}>
                    <Link to="/medications" search={{ id: b.medicationId }} title={`Open ${b.name} in Medications`}>
                      {b.name}
                    </Link>
                    <span className="sym-med-words"> · {courseWords({ from: b.from, to: b.to, startKnown: b.startKnown, ongoing: b.ongoing, firstSeen: b.firstSeen })}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="sym-prose">No medication was taken in this window.</p>
          )}
        </Section>
        <Section title="Appointments and dose changes" count={markers.length || undefined}>
          {markers.length ? (
            <ul className="sym-overlay-list">
              {markers.map((m, i) => (
                <li key={`${m.medicationId ?? m.encounterId ?? 'm'}-${i}`}>
                  <span className="mono sym-overlay-date">{String(m.x)}</span>
                  {m.kind === 'encounter' && m.encounterId ? (
                    <Link to="/encounters" search={{ id: m.encounterId, view: String(m.x) < today ? 'past' : undefined }}>
                      {m.label}
                    </Link>
                  ) : m.medicationId ? (
                    <Link to="/medications" search={{ id: m.medicationId }}>
                      {m.label}
                    </Link>
                  ) : (
                    m.label
                  )}
                  <span className="sym-med-words"> · {m.kind === 'encounter' ? 'appointment' : 'medication event'}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sym-prose">No appointments or dose changes in this window.</p>
          )}
        </Section>
      </div>
      {showSymptoms || showSleep ? <p className="sym-prose sym-chart-foot">Hover a point or a medication row to read it. A date known only to the month or year is drawn at the start of that month or year.</p> : null}
    </div>
  );
}
