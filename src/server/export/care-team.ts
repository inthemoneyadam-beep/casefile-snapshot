/**
 * Make a packet: the "Care team summary" page (2026-10-09, the user's request 6; lead's corrections). One page for the user
 * to read before deciding: the accepted candidates grouped by step 1 to 4 (then any without a step), each with name,
 * practice, status, the flare-test verdict and its reason, quoted cost, access type, licensed in the home state, earliest visit,
 * and "unverified" / "not backed yet" marks where they apply. Declined candidates come last in their step, marked.
 * Proposals waiting for a yes and turned-down ones are left out (services/care-team.ts careTeamSummary).
 *
 * Printed with the packet's own CSS (export/html.ts) plus the few rules below. It stays on one page: one table (one
 * header, a row per step), a candidate column wide enough for a name and a practice, the marks of a candidate on one
 * line in words under its row, and the type size chosen from an estimate of the printed height (summaryLayout), the
 * largest that fits one Letter page (review 2026-10-09: printed, the first layout ran onto a second page from about
 * five candidates). Only a list too long for the smallest type runs on.
 */
import type { CareSummary, CareSummaryRow } from '../services/care-team';

function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The type sizes tried, largest first: font size and the padding above and below a cell (pt). */
export const SUMMARY_LEVELS = [
  { name: 'roomy', font: 9, pad: 2.5 },
  { name: 'dense', font: 8, pad: 1.5 },
  { name: 'denser', font: 7, pad: 1 },
  { name: 'densest', font: 6.2, pad: 0.5 },
] as const;
export type SummaryLevel = (typeof SUMMARY_LEVELS)[number]['name'];

/** The columns, as shares of the page width (they add up to 1). */
const COLS = [
  { key: 'candidate', label: 'Candidate', share: 0.26 },
  { key: 'status', label: 'Status', share: 0.09 },
  { key: 'flare', label: 'Flare test', share: 0.24 },
  { key: 'cost', label: 'Quoted cost', share: 0.14 },
  { key: 'access', label: 'Access', share: 0.11 },
  { key: 'home_state', label: 'Home-state licence', share: 0.08 },
  { key: 'visit', label: 'Earliest visit', share: 0.08 },
] as const;

/** Letter, with the packet's print margins (export/pdf.ts: 0.6in each side, 0.6in top, 0.75in bottom), in points. */
const PAGE_WIDTH = (8.5 - 1.2) * 72;
const PAGE_HEIGHT = (11 - 1.35) * 72;
/** What the estimate may use of the page: a margin for its error. */
const PAGE_BUDGET = PAGE_HEIGHT * 0.9;
const LINE = 1.3;
const CELL_X_PAD = 3;
/** The average width of a character, as a share of the font size (a little wide: wrapping wastes some). */
const CHAR = 0.56;

export const SUMMARY_INTRO =
  'Everyone on the care team list, by step: the order the team is being built in. Proposals waiting for a yes and anyone turned down are left out; declined candidates come last in their step.';

/** The lines a text takes in a column of `width` points at `font` points. */
function linesOf(text: string, width: number, font: number): number {
  if (!text) return 0;
  const perLine = Math.max(4, Math.floor((width - 2 * CELL_X_PAD) / (font * CHAR)));
  return text.split('\n').reduce((n, part) => n + Math.max(1, Math.ceil(part.length / perLine)), 0);
}

const MARK_WORDS: Record<keyof CareSummaryRow['marks'], string> = {
  name: 'name',
  practice: 'practice',
  quotedCost: 'cost',
  accessType: 'access',
  licensedInHomeState: 'Home-state licence',
  earliestVisit: 'earliest visit',
};

/** The marks of a row in words: "not backed yet: cost, access · unverified: name" (empty when none). */
export function marksWords(r: CareSummaryRow): Array<{ mark: 'not backed yet' | 'unverified'; facts: string[] }> {
  const out: Array<{ mark: 'not backed yet' | 'unverified'; facts: string[] }> = [];
  for (const mark of ['not backed yet', 'unverified'] as const) {
    const facts = (Object.keys(MARK_WORDS) as Array<keyof CareSummaryRow['marks']>).filter((f) => r.marks[f] === mark).map((f) => MARK_WORDS[f]);
    if (facts.length) out.push({ mark, facts });
  }
  return out;
}

function sub(r: CareSummaryRow): string {
  return [r.practice, r.role].filter(Boolean).join(' · ');
}
function verdictText(r: CareSummaryRow): string {
  return r.verdict ? `${r.verdict}${r.verdictReason ? `: ${r.verdictReason}` : ''}` : 'not decided yet';
}

/** The printed height of the page at one type size, estimated in points. */
export function summaryHeight(s: CareSummary, level: (typeof SUMMARY_LEVELS)[number]): number {
  const f = level.font;
  const w = (k: (typeof COLS)[number]['key']) => PAGE_WIDTH * COLS.find((c) => c.key === k)!.share;
  const row = (r: CareSummaryRow): number => {
    const cand = linesOf(`${r.name}${r.declined ? ' (declined)' : ''}`, w('candidate'), f) + linesOf(sub(r), w('candidate'), f * 0.9) * 0.9;
    const lines = Math.max(
      cand,
      linesOf(r.status, w('status'), f),
      linesOf(verdictText(r), w('flare'), f),
      linesOf(r.quotedCost ?? 'not known', w('cost'), f),
      linesOf(r.accessType, w('access'), f),
      linesOf(r.licensedInHomeState, w('home_state'), f),
      linesOf(r.earliestVisit ?? 'not known', w('visit'), f),
    );
    const marks = marksWords(r);
    const marksText = marks.map((m) => `${m.mark} ${m.facts.join(', ')}`).join('   ');
    return lines * f * LINE + 2 * level.pad + 1 + (marks.length ? linesOf(marksText, PAGE_WIDTH, f * 0.85) * f * 0.85 * LINE + level.pad + 1 : 0);
  };
  const heading = 15 * 1.25 + 12; // the h2, its rule and margin
  const intro = linesOf(`${SUMMARY_INTRO} unverified found by a web search and not yet checked by phone. not backed yet no source says it as it reads now. The flare test verdict is typed by a person. As of 2026-10-09 12:00.`, PAGE_WIDTH, f) * f * 1.4 + 6;
  const head = Math.max(...COLS.map((c) => linesOf(c.label.toUpperCase(), w(c.key), f * 0.8))) * f * 0.8 * LINE + 2 * level.pad + 1;
  const steps = s.groups.length * (f * 1.05 * LINE + 2 * level.pad + 4);
  return heading + intro + head + steps + s.groups.reduce((n, g) => n + g.rows.reduce((m, r) => m + row(r), 0), 0);
}

/** The largest type that fits one page; the smallest when nothing does (the list then runs onto a second page). */
export function summaryLayout(s: CareSummary): { level: SummaryLevel; fits: boolean; height: number } {
  for (const level of SUMMARY_LEVELS) {
    const height = summaryHeight(s, level);
    if (height <= PAGE_BUDGET) return { level: level.name, fits: true, height };
  }
  const last = SUMMARY_LEVELS[SUMMARY_LEVELS.length - 1];
  return { level: last.name, fits: false, height: summaryHeight(s, last) };
}

/** The rules of this page only (added to the packet's stylesheet). */
export const CARE_TEAM_PACKET_CSS = `
section.careteam .ct-intro { margin: 0 0 6pt; line-height: 1.4; }
table.ct-sum { table-layout: fixed; width: 100%; margin: 0; font-size: 1em; line-height: ${LINE}; }
${COLS.map((c, i) => `table.ct-sum col.c${i} { width: ${(c.share * 100).toFixed(1)}%; }`).join('\n')}
table.ct-sum th { font-size: 0.8em; padding: var(--ct-pad) ${CELL_X_PAD}pt; }
table.ct-sum td { padding: var(--ct-pad) ${CELL_X_PAD}pt; overflow-wrap: anywhere; }
table.ct-sum tbody.ct-step th { font-size: 1.05em; text-transform: none; letter-spacing: 0; color: #111; border-bottom: 1px solid #999; padding-top: calc(var(--ct-pad) + 4pt); }
table.ct-sum tbody.ct-cand { page-break-inside: avoid; }
table.ct-sum tbody.ct-cand tr.ct-main:not(:last-child) td { border-bottom: 0; }
table.ct-sum tr.ct-marks td { font-size: 0.85em; padding-top: 0; color: #444; }
table.ct-sum .ct-sub { font-size: 0.9em; color: #666; }
table.ct-sum tbody.declined tr.ct-main td { color: #777; }
${SUMMARY_LEVELS.map((l) => `section.careteam.ct-${l.name} { font-size: ${l.font}pt; --ct-pad: ${l.pad}pt; }`).join('\n')}
.ct-mark { display: inline-block; font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.04em; border: 1px solid #8d6f22; color: #8d6f22; padding: 0 2pt; border-radius: 2px; white-space: nowrap; line-height: 1.35; margin-right: 2pt; }
.ct-verdict { font-weight: 600; }
.ct-verdict.pass { color: #3f6626; }
.ct-verdict.fail { color: #a0502f; }
`;

function verdictCell(r: CareSummaryRow): string {
  if (!r.verdict) return '<span class="muted">not decided yet</span>';
  const cls = r.verdict === 'Pass' ? 'pass' : r.verdict === 'Fail' ? 'fail' : '';
  return `<span class="ct-verdict ${cls}">${esc(r.verdict)}</span>${r.verdictReason ? `: ${esc(r.verdictReason)}` : ''}`;
}

function rowHtml(r: CareSummaryRow): string {
  const marks = marksWords(r);
  const s = sub(r);
  const main = `<tr class="ct-main"><td><strong>${esc(r.name)}</strong>${r.declined ? ' (declined)' : ''}${s ? `<div class="ct-sub">${esc(s)}</div>` : ''}</td><td>${esc(r.status)}</td><td>${verdictCell(r)}</td><td>${r.quotedCost ? esc(r.quotedCost) : '<span class="muted">not known</span>'}</td><td>${esc(r.accessType)}</td><td>${esc(r.licensedInHomeState)}</td><td>${r.earliestVisit ? esc(r.earliestVisit) : '<span class="muted">not known</span>'}</td></tr>`;
  const line = marks.length ? `<tr class="ct-marks"><td colspan="${COLS.length}">${marks.map((m) => `<span class="ct-mark">${esc(m.mark)}</span>${esc(m.facts.join(', '))}`).join('&emsp;')}</td></tr>` : '';
  return `<tbody class="ct-cand${r.declined ? ' declined' : ''}">${main}${line}</tbody>`;
}

/** The page, as one packet section (it starts on a page of its own). */
export function renderCareTeamSection(s: CareSummary, generated: string): string {
  const layout = summaryLayout(s);
  const body = s.groups.length
    ? `<table class="ct-sum"><colgroup>${COLS.map((_, i) => `<col class="c${i}">`).join('')}</colgroup><thead><tr>${COLS.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
${s.groups
  .map((g) => `<tbody class="ct-step"><tr><th colspan="${COLS.length}">${g.step ? `Step ${esc(g.title)}` : esc(g.title)} <span class="muted">(${g.rows.length})</span></th></tr></tbody>${g.rows.map(rowHtml).join('')}`)
  .join('\n')}
</table>`
    : '<p class="muted">Nobody is on the care team list yet.</p>';
  return `<section class="page-break careteam ct-${layout.level}">
<h2>Care team summary</h2>
<p class="muted ct-intro">${esc(SUMMARY_INTRO)} <span class="ct-mark">unverified</span>found by a web search and not yet checked by phone. <span class="ct-mark">not backed yet</span>no source says it as it reads now. The flare test verdict is typed by a person. As of ${esc(generated)}.</p>
${body}
</section>`;
}
