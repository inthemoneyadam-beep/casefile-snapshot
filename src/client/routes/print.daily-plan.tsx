/**
 * /print/daily-plan?date= — a one-page plan for a day: hard stops, the day's
 * appointments, tasks by owner, overdue items, promised follow-ups, the
 * medications to take, a symptom checklist, and lines for notes. Legible on
 * screen and in print preview at Letter size (print.css hides the chrome).
 * Keys: p print, [ ] previous / next day, t today.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { formatPartialDate, todayIso, type DatePrecision } from '@shared/dates';
import { ownerLabel, useDailyPlan, type DailyPlan, type Task } from '../api/tasks';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { Button } from '../ui/Button';
import { Kbd } from '../ui/Kbd';
import { DAY_PLACEHOLDER, readDay } from '../ui/DayInput';
import { encounterKindWords } from '../features/encounters/words';
import '../features/tasks/tasks.css';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const searchSchema = z.object({
  date: z
    .string()
    .regex(DAY_RE)
    .optional()
    .catch(undefined),
});
export type DailyPlanSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/print/daily-plan')({
  validateSearch: (s: Record<string, unknown>): DailyPlanSearch => searchSchema.parse(s),
  component: DailyPlanPage,
});

function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

/** Group tasks by owner: me first, then chief of staff, advocate, then named people. */
function byOwner(tasks: Task[]): Array<[string, Task[]]> {
  const order = ['me', 'chief_of_staff', 'advocate'];
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = t.owner === 'person' ? `person:${t.ownerName ?? 'person'}` : t.owner;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.localeCompare(b);
    })
    .map(([k, list]) => [k.startsWith('person:') ? k.slice(7) : ownerLabel({ owner: k, ownerName: null }), list]);
}

/**
 * The plan's day, typed as YYYY-MM-DD (never the browser's mm/dd/yyyy picker): taken on Enter or on leaving the box;
 * a day that cannot be read puts the box back.
 */
function PlanDayBox({ date, onDate }: { date: string; onDate: (d: string) => void }) {
  const [draft, setDraft] = useState(date);
  useEffect(() => setDraft(date), [date]);
  function commit() {
    const { iso } = readDay(draft);
    if (iso) {
      if (iso !== date) onDate(iso);
      setDraft(iso);
    } else setDraft(date);
  }
  return (
    <input
      type="text"
      className="day-input dp-date"
      aria-label="Plan day, as YYYY-MM-DD"
      placeholder={DAY_PLACEHOLDER}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          setDraft(date);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function DailyPlanPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const date = search.date ?? todayIso();
  const plan = useDailyPlan(date);
  const p = plan.data;

  useEffect(() => {
    document.body.classList.add('print-view');
    return () => document.body.classList.remove('print-view');
  }, []);

  const latest = useRef(date);
  latest.current = date;
  function go(d: string) {
    void navigate({ search: { date: d }, replace: true });
  }
  function print() {
    window.print();
  }

  useBindings(
    [
      { keys: 'p', description: 'Print the daily plan', group: 'Page', run: print },
      { keys: '[', description: 'Previous day', group: 'Page', run: () => go(shiftDay(latest.current, -1)) },
      { keys: ']', description: 'Next day', group: 'Page', run: () => go(shiftDay(latest.current, 1)) },
      { keys: 't', description: 'Today', group: 'Page', run: () => go(todayIso()) },
    ],
    [],
  );
  useRegisterCommands(
    [
      { id: 'daily-plan.print', title: 'Print the daily plan', group: 'Tasks', shortcut: 'p', run: print },
      { id: 'daily-plan.today', title: 'Daily plan: today', group: 'Tasks', run: () => go(todayIso()) },
    ],
    [],
  );

  const owners = useMemo(() => byOwner(p?.tasksDue ?? []), [p?.tasksDue]);

  return (
    <div className="page">
      <div className="toolbar dp-toolbar no-print">
        <Link to="/tasks" className="btn sm">
          To-do list
        </Link>
        <PlanDayBox date={date} onDate={go} />
        <Button size="sm" onClick={() => go(shiftDay(date, -1))}>
          Previous
        </Button>
        <Button size="sm" onClick={() => go(todayIso())}>
          Today
        </Button>
        <Button size="sm" onClick={() => go(shiftDay(date, 1))}>
          Next
        </Button>
        <span className="spacer" />
        <span className="keys" aria-label="Keys">
          <span>
            <Kbd>p</Kbd> print
          </span>
          <span>
            <Kbd>[</Kbd>
            <Kbd>]</Kbd> day
          </span>
          <span>
            <Kbd>t</Kbd> today
          </span>
        </span>
        <Button size="sm" variant="primary" onClick={print}>
          Print
        </Button>
      </div>
      <div className="dp-page">
        {plan.isPending && !p ? (
          <div className="printable muted">Preparing the plan…</div>
        ) : plan.isError && !p ? (
          <div className="printable">
            <div className="notice bad">Could not load the plan: {plan.error instanceof Error ? plan.error.message : 'error'}</div>
          </div>
        ) : p ? (
          <PlanSheet plan={p} owners={owners} />
        ) : null}
      </div>
    </div>
  );
}

function Box() {
  return <span className="dp-box" aria-hidden="true" />;
}

function PlanSheet({ plan: p, owners }: { plan: DailyPlan; owners: Array<[string, Task[]]> }) {
  const appointments = [...p.encounters, ...p.encountersSoon];
  return (
    <div className="printable">
      <div className="dp-head">
        <div>
          <h1>Daily plan</h1>
          <div className="meta">
            {longDate(p.date)}
            {p.patientName ? ` · ${p.patientName}` : ''}
          </div>
        </div>
        <div className="meta mono">{p.date}</div>
      </div>

      {p.hardStops.length ? (
        <div className="hardstop">
          <strong>Never give</strong>
          {p.hardStops.map((h) => (
            <div key={h.id}>
              {h.substance}
              {h.reaction ? <span className="muted"> — {h.reaction}</span> : null}
              {h.severity && h.severity !== 'unknown' ? <span className="muted"> ({h.severity.replace(/_/g, ' ')})</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="dp-grid">
        <div className="wide">
          <h2>Appointments</h2>
          {appointments.length ? (
            <ul className="dp-list">
              {appointments.map((e) => (
                <li key={e.id}>
                  <Box />
                  <span>
                    {e.title}
                    <span className="sub">
                      {[encounterKindWords(e.kind), e.clinicianName, e.institutionName, e.location].filter(Boolean).join(' · ')}
                      {e.prepNotes ? ` — ${e.prepNotes}` : ''}
                    </span>
                    {e.questions.length ? <span className="sub">Ask: {e.questions.join(' · ')}</span> : null}
                  </span>
                  <span className="when">
                    {e.occurredAt && e.occurredAt.slice(0, 10) !== p.date ? `${formatPartialDate(e.occurredAt, e.occurredAtPrecision as DatePrecision)} ` : ''}
                    {e.timeText ?? ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="dp-empty">No appointments today or in the coming week.</div>
          )}
        </div>

        <div>
          <h2>To-dos due today</h2>
          {owners.length ? (
            owners.map(([owner, tasks]) => (
              <div key={owner}>
                <div className="dp-owner">{owner}</div>
                <ul className="dp-list">
                  {tasks.map((t) => (
                    <li key={t.id}>
                      <Box />
                      <span>
                        {t.title}
                        {t.detail ? <span className="sub">{t.detail}</span> : null}
                      </span>
                      <span className="when">{t.priority !== 'normal' ? t.priority : ''}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <div className="dp-empty">Nothing due today.</div>
          )}
          {p.tasksSoon.length ? (
            <>
              <div className="dp-owner">Coming up</div>
              <ul className="dp-list">
                {p.tasksSoon.map((t) => (
                  <li key={t.id}>
                    <Box />
                    <span>
                      {t.title}
                      <span className="sub">{ownerLabel(t)}</span>
                    </span>
                    <span className="when">{t.dueAt ? formatPartialDate(t.dueAt) : ''}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>

        <div>
          <h2>Overdue</h2>
          {p.overdue.length ? (
            <ul className="dp-list">
              {p.overdue.map((t) => (
                <li key={t.id}>
                  <Box />
                  <span>
                    {t.title}
                    <span className="sub">{ownerLabel(t)}</span>
                  </span>
                  <span className="when">{t.dueAt ? formatPartialDate(t.dueAt) : ''}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="dp-empty">Nothing overdue.</div>
          )}

          <h2>Follow-ups promised to me</h2>
          {p.followUpsDue.length ? (
            <ul className="dp-list">
              {p.followUpsDue.map((f) => (
                <li key={f.id}>
                  <Box />
                  <span>
                    {f.followUpPromised ?? f.subject}
                    <span className="sub">{f.withWhom}</span>
                  </span>
                  <span className="when">{f.followUpDue ?? 'no date'}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="dp-empty">No follow-ups outstanding.</div>
          )}
        </div>

        <div className="wide">
          <h2>Medications</h2>
          {p.medicationsActive.length ? (
            // How and For are printed only when some medication has them (the tick column is always there).
            <table className="dp-table">
              <thead>
                <tr>
                  <th>Medication</th>
                  <th>Dose</th>
                  {p.medicationsActive.some((m) => m.route || m.frequency) ? <th>How</th> : null}
                  {p.medicationsActive.some((m) => m.indication) ? <th>For</th> : null}
                  <th>Taken</th>
                </tr>
              </thead>
              <tbody>
                {p.medicationsActive.map((m) => (
                  <tr key={m.id}>
                    <td>
                      {m.name}
                      {m.status === 'prn' ? <span className="muted"> (as needed)</span> : null}
                    </td>
                    <td className="mono">{[m.dose, m.unit].filter(Boolean).join(' ')}</td>
                    {p.medicationsActive.some((x) => x.route || x.frequency) ? <td>{[m.route, m.frequency].filter(Boolean).join(', ')}</td> : null}
                    {p.medicationsActive.some((x) => x.indication) ? <td className="muted">{m.indication ?? ''}</td> : null}
                    <td>
                      <span className="dp-boxes">
                        <Box />
                        <Box />
                        <Box />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="dp-empty">No active medications recorded.</div>
          )}
        </div>

        <div className="wide">
          <h2>Symptoms (0 none – 10 worst)</h2>
          {p.symptomsToLog.length ? (
            <table className="dp-table">
              <tbody>
                {p.symptomsToLog.map((s) => (
                  <tr key={s.id}>
                    <td style={{ width: '40%' }}>{s.name}</td>
                    <td>
                      <span className="dp-scale" aria-label={s.logged ? `logged ${s.score}` : 'not logged'}>
                        {Array.from({ length: 11 }, (_, i) => (
                          <span key={i} className={s.logged && s.score === i ? 'on' : ''}>
                            {i}
                          </span>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="dp-empty">No symptoms set up. Define them under Symptoms.</div>
          )}
        </div>

        <div className="wide">
          <h2>Notes</h2>
          {p.notes ? <p className="dp-notes">{p.notes}</p> : null}
          <div className="dp-lines">
            {Array.from({ length: p.notes ? 4 : 6 }, (_, i) => (
              <div key={i} />
            ))}
          </div>
        </div>
      </div>

      <div className="footer">
        CaseFile daily plan for {p.date}, prepared {p.generatedAt.slice(0, 16).replace('T', ' ')}. Never-give drugs and medications are copied from CaseFile; check against the current prescription.
      </div>
    </div>
  );
}
