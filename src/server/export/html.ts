/**
 * Renders a PacketData into one self-contained HTML document: inline CSS,
 * print palette, system fonts only (nothing is fetched), inline SVG charts.
 * The same HTML is what the browser turns into the PDF, what the preview
 * iframe shows, and what is stored when no browser is available.
 */
import { formatPartialDate, type DatePrecision } from '../../shared/dates';
import { TIMELINE_KIND_LABELS, TIMELINE_KIND_ONE, type TimelineKind } from '../../shared/timeline';
import type { PacketData, PacketDocument, PacketFact, PacketIntolerance, PacketMedication, PacketPatientNote, PacketRef } from './types';
import { readStartsById, type StartReading } from '../services/medications';
import { CARE_TEAM_PACKET_CSS, renderCareTeamSection } from './care-team';

export type RenderMode = 'pdf' | 'preview' | 'html';

export interface RenderOptions {
  mode: RenderMode;
}

export function esc(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function nl2br(s: string | null | undefined): string {
  return esc(s).replace(/\r?\n/g, '<br>');
}

function date(iso: string | null | undefined, precision?: string | null, text?: string | null): string {
  if (!iso) return text ? `<span class="muted" title="as written">${esc(text)}</span>` : '<span class="muted">—</span>';
  const shown = formatPartialDate(iso, (precision as DatePrecision) ?? undefined);
  const approx = precision && precision !== 'day' ? '<span class="muted"> ~</span>' : '';
  const title = text && text !== shown ? ` title="as written: ${esc(text)}"` : '';
  return `<span class="mono"${title}>${esc(shown)}${approx}</span>`;
}

/**
 * How far each medication's start can be trusted (services/medications readStartsById, batched): a start that is only
 * the date of a list that named the drug is not a start. Empty when it cannot be read; the stored start is then shown.
 */
function startReadings(meds: PacketMedication[]): Map<string, StartReading> {
  try {
    return readStartsById(meds.map((x) => x.id));
  } catch {
    return new Map();
  }
}

/** The Start cell: the recorded start, or "not recorded (first seen …)". */
function startCell(x: PacketMedication, s: StartReading | undefined): string {
  if (!s || s.startRecorded) return date(x.startDate, x.startDatePrecision, x.startDateText);
  const seen = s.firstSeen ? ` (first seen ${formatPartialDate(s.firstSeen, (s.firstSeenPrecision as DatePrecision) ?? undefined)})` : '';
  return `<span class="muted">not recorded${esc(seen)}</span>`;
}

function human(s: string | null | undefined): string {
  return esc((s ?? '').replace(/_/g, ' '));
}

function status(s: string | null | undefined): string {
  if (!s) return '';
  return `<span class="status ${esc(s)}">${human(s)}</span>`;
}

/**
 * A fact's verification state. A confirmed fact the patient checked only
 * against a summary reads "from a summary"; one checked against the original
 * record reads "confirmed" with that said on hover.
 */
function factStatus(s: string | null | undefined, basis: string | null | undefined): string {
  if (s === 'confirmed' && basis === 'summary') return '<span class="status summary" title="checked against a summary only; the original record has not been seen">from a summary</span>';
  if (s === 'confirmed' && basis === 'original') return '<span class="status confirmed" title="checked against the original record">confirmed</span>';
  return status(s);
}

/** `[D3 p.2]` with a hover quote; documents outside the packet are named instead of numbered. */
export function refTag(r: PacketRef, docs: PacketDocument[]): string {
  const page = r.pageNumber ? ` p.${r.pageNumber}` : '';
  const quote = r.quote ? ` title="${esc(r.quote)}"` : '';
  const unverified = r.verified === false ? '<span class="unv" title="quote not found verbatim in the page text">?</span>' : '';
  if (r.docN != null) {
    const d = docs[r.docN - 1];
    const pp = d && d.packetPage != null && r.pageNumber ? ` <span class="pp">pkt ${d.packetPage + r.pageNumber - 1}</span>` : '';
    return `<span class="ref"${quote}>[D${r.docN}${page}]${unverified}${pp}</span>`;
  }
  return `<span class="ref out"${quote}>[${esc(r.documentTitle ?? 'document')}${page}, not in packet]${unverified}</span>`;
}

function refs(list: PacketRef[], docs: PacketDocument[]): string {
  if (!list.length) return '<span class="muted">no citation</span>';
  return list.map((r) => refTag(r, docs)).join(' ');
}

/**
 * The patient's own statement under an item it overrides. The item above is
 * printed as recorded; this line is separate so neither is rewritten.
 */
export function patientNoteLine(n: PacketPatientNote | null | undefined, docs: PacketDocument[]): string {
  if (!n) return '';
  const statement = n.statement.trim();
  const reason = n.reason && n.reason.trim() && n.reason.trim() !== statement ? ` <span class="muted">(${esc(n.reason.trim())})</span>` : '';
  const cited = n.refs.length ? ` ${refs(n.refs, docs)}` : '';
  return `<div class="pnote"><span class="label">Patient's notes on this:</span> ${esc(statement)}${reason}${cited}</div>`;
}

/** Content-Security-Policy for the packet document: nothing is fetched and nothing runs, wherever it is opened. */
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

const CSS = `
@page { size: Letter; margin: 0.6in; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: 'Segoe UI', 'Helvetica Neue', Arial, Helvetica, sans-serif; font-size: 10.5pt; line-height: 1.4; color: #111; background: #fff; }
h1 { font-family: Georgia, 'Times New Roman', serif; font-weight: 500; font-size: 22pt; line-height: 1.2; margin: 0 0 6pt; }
h2 { font-family: Georgia, 'Times New Roman', serif; font-weight: 500; font-size: 15pt; line-height: 1.25; margin: 0 0 8pt; padding-bottom: 2pt; border-bottom: 1px solid #333; page-break-after: avoid; }
h3 { font-size: 11.5pt; font-weight: 600; margin: 12pt 0 4pt; page-break-after: avoid; }
h4 { font-size: 9pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #555; margin: 10pt 0 3pt; page-break-after: avoid; }
p { margin: 0 0 6pt; }
a { color: inherit; text-decoration: none; }
table { border-collapse: collapse; width: 100%; font-size: 9.5pt; page-break-inside: auto; margin: 0 0 8pt; }
th { text-align: left; border-bottom: 1px solid #333; padding: 2pt 5pt; font-weight: 600; color: #333; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.04em; vertical-align: bottom; }
td { padding: 3pt 5pt; border-bottom: 1px solid #d4d0c8; vertical-align: top; }
tr { page-break-inside: avoid; }
thead { display: table-header-group; }
td.num, th.num { text-align: right; font-family: Consolas, 'Courier New', monospace; font-variant-numeric: tabular-nums; }
td.n { width: 28pt; color: #555; font-family: Consolas, 'Courier New', monospace; }
.mono { font-family: Consolas, 'Courier New', monospace; font-size: 9pt; white-space: nowrap; }
.muted { color: #666; }
.faint { color: #999; }
.small { font-size: 9pt; }
.xs { font-size: 8pt; }
.serif { font-family: Georgia, 'Times New Roman', serif; }
.ref { font-family: Consolas, 'Courier New', monospace; font-size: 8.5pt; color: #2f6657; white-space: nowrap; }
.ref.out { color: #777; white-space: normal; }
.ref .unv { color: #8d6f22; font-weight: 700; margin-left: 1px; }
.ref .pp { color: #999; font-size: 7.5pt; }
.status { display: inline-block; font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.05em; border: 1px solid #888; color: #444; padding: 0 3pt; border-radius: 2px; white-space: nowrap; line-height: 1.5; }
.status.confirmed { border-color: #5f7a3c; color: #5f7a3c; }
.status.summary { border-color: #3f6680; color: #3f6680; }
.status.disputed, .status.bad { border-color: #a0502f; color: #a0502f; }
.status.unverified, .status.new { border-color: #8d6f22; color: #8d6f22; }
.status.superseded, .status.dismissed { border-color: #999; color: #777; }
.status.active { border-color: #2f6657; color: #2f6657; }
.flag { display: inline-block; min-width: 10pt; text-align: center; font-weight: 700; color: #a0502f; font-family: Consolas, monospace; }
.pnote { font-size: 8.5pt; margin: 2pt 0 0; padding-left: 5pt; border-left: 2px solid #2f6657; color: #222; }
.pnote .label, .pnote-label { font-weight: 600; color: #2f6657; }
tr.disputed td { color: #777; }
.chartnote { font-size: 8pt; color: #666; margin: 0 0 4pt; }
.cover { padding-top: 1.2in; }
.cover .brand { font-size: 8.5pt; letter-spacing: 0.14em; text-transform: uppercase; color: #777; margin-bottom: 18pt; }
.cover h1 { font-size: 26pt; margin-bottom: 14pt; }
.kv { width: auto; margin: 0 0 14pt; font-size: 10pt; }
.kv td { border: 0; padding: 1pt 12pt 1pt 0; }
.kv td:first-child { color: #666; white-space: nowrap; }
.summary { font-family: Georgia, 'Times New Roman', serif; font-size: 11.5pt; line-height: 1.5; max-width: 6.2in; margin: 0 0 14pt; }
.contents { list-style: none; padding: 0; margin: 0; max-width: 5in; }
.contents li { display: flex; justify-content: space-between; padding: 2pt 0; border-bottom: 1px dotted #ccc; }
.contents li span:last-child { color: #666; font-family: Consolas, monospace; font-size: 9pt; }
.page-break { page-break-before: always; }
.note { border-left: 3px solid #888; padding: 5pt 9pt; color: #333; background: #f4f2ee; margin: 0 0 10pt; font-size: 9.5pt; }
.note.warn { border-left-color: #8d6f22; }
.hardstop { border: 2px solid #a0281c; background: #fbeae7; padding: 7pt 10pt; margin: 6pt 0 10pt; page-break-inside: avoid; }
.hardstop .label { color: #a0281c; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; font-size: 10pt; margin-bottom: 3pt; }
.hardstop ul { margin: 0; padding-left: 14pt; font-size: 11pt; }
.hardstop li { margin: 1pt 0; }
.hardstop .none { color: #555; font-style: italic; }
.card { border: 1px solid #333; padding: 8pt 10pt; margin: 0 0 10pt; page-break-inside: avoid; }
.card h1 { font-size: 16pt; margin-bottom: 2pt; }
.two { display: flex; gap: 14pt; }
.two > div { flex: 1 1 0; min-width: 0; }
.finding { border: 1px solid #ccc; border-left: 3px solid #555; padding: 6pt 9pt; margin: 0 0 8pt; page-break-inside: avoid; }
.finding.high { border-left-color: #a0281c; }
.finding.medium { border-left-color: #8d6f22; }
.finding.low, .finding.info { border-left-color: #4f6d85; }
.finding .head { display: flex; gap: 8pt; align-items: baseline; flex-wrap: wrap; margin-bottom: 2pt; }
.finding .title { font-weight: 600; font-size: 11pt; }
.finding .why { font-family: Georgia, 'Times New Roman', serif; font-style: italic; margin: 2pt 0 4pt; }
.finding ul { margin: 2pt 0 0; padding-left: 14pt; font-size: 9.5pt; }
.chart { margin: 4pt 0 6pt; page-break-inside: avoid; }
.chart svg { max-width: 100%; height: auto; }
pre.pagetext { white-space: pre-wrap; word-break: break-word; font-family: Consolas, 'Courier New', monospace; font-size: 8.5pt; line-height: 1.35; border: 1px solid #ccc; padding: 6pt 8pt; background: #fafaf8; margin: 0 0 8pt; }
.pagehead { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.08em; color: #777; margin: 8pt 0 2pt; }
.quote { font-family: Consolas, 'Courier New', monospace; font-size: 8.5pt; color: #444; }
.quote::before, .quote::after { content: '"'; color: #999; }
.footer { margin-top: 14pt; padding-top: 4pt; border-top: 1px solid #ccc; font-size: 8pt; color: #777; }
.screen-note { display: none; }
@media screen {
  body { background: #e8e4dc; padding: 24px 0; }
  .sheet { width: 8.5in; min-height: 11in; margin: 0 auto; background: #fff; padding: 0.6in; box-shadow: 0 2px 12px rgba(0,0,0,0.18); }
  .screen-note { display: block; width: 8.5in; margin: 0 auto 12px; font-size: 10pt; color: #333; background: #fbf6e6; border: 1px solid #c9b97a; padding: 8px 12px; }
}
@media print { .sheet { width: auto; padding: 0; box-shadow: none; } }
`;

/** " · mg/dL", or " · mg/dL and g/dL": every unit the values were printed in, never one unit over mixed values (rule 5). */
function unitsHeader(s: { unit: string | null; units?: string[] }): string {
  const units = (s.units ?? (s.unit ? [s.unit] : [])).map((u) => u.trim()).filter(Boolean);
  if (!units.length) return '';
  const list = units.length === 1 ? units[0] : `${units.slice(0, -1).join(', ')} and ${units[units.length - 1]}`;
  return ` · ${esc(list)}`;
}

/** A value computed by the patient (2026-10-09): its label, each input with its page, and "input changed: compute again". */
function computedCell(c: { label: string; inputs: string[]; changed: boolean }): string {
  return `<span class="small">${esc(c.label)}</span>${c.changed ? ' <span class="small muted">(input changed: compute again)</span>' : ''}${c.inputs.map((i) => `<div class="xs muted">${esc(i)}</div>`).join('')}`;
}

export function renderPacketHtml(data: PacketData, opts: RenderOptions): string {
  const { config } = data;
  const docs = data.documents;
  const sections: string[] = [];
  const contents: Array<[string, string]> = [];

  // --- Cover ---------------------------------------------------------------
  const generated = data.generatedAt.slice(0, 16).replace('T', ' ');
  const counts: string[] = [];
  counts.push(`${docs.length} document${docs.length === 1 ? '' : 's'}`);
  const factCount = data.factGroups.reduce((a, g) => a + g.facts.length, 0);
  if (data.factsIncluded) counts.push(`${factCount} fact${factCount === 1 ? '' : 's'}`);
  if (data.findingsIncluded) counts.push(`${data.findings.length} finding${data.findings.length === 1 ? '' : 's'}`);
  if (data.labs.length) counts.push(`${data.labs.length} lab series`);
  if (data.timeline) counts.push(`${data.timeline.items.length} timeline entries`);
  if (data.careTeam) counts.push('care team summary');

  // --- How to read ---------------------------------------------------------
  sections.push(`<section class="howto">
<h2>How to read this packet</h2>
<p>This packet was assembled from the patient's own case ledger (Casefile). Statements extracted from documents point back to a page of a source document, and the originals are appended at the end so each reference can be checked. Entries marked <em>entered by hand</em>, <em>no citation</em> or <em>no source document</em> were recorded by the patient or their helpers and have no source page to check against; the medication and allergy lists are the patient's own records.</p>
<h4>References</h4>
<p><span class="ref">[D3 p.2]</span> means page 2 of document 3 in the document index${opts.mode === 'pdf' ? '; <span class="ref">pkt 41</span> after it is the position of that page in this PDF' : ''}. A reference marked <span class="ref">[…]<span class="unv">?</span></span> carries a quote that could not be found verbatim in the stored page text, so it was located approximately. <span class="ref out">[title, not in packet]</span> points at a document that was not included.</p>
<h4>Fact status</h4>
<p>${status('confirmed')} the patient checked the statement against the source page. ${status('unverified')} extracted from the document but not yet checked. ${status('disputed')} the patient considers the source wrong or misread; it is shown so the disagreement is visible, not because it is accepted. ${factStatus('confirmed', 'summary')} the patient checked that a summary or compilation says this, but the original record has not been seen; treat it as secondhand. Superseded statements are omitted unless chosen explicitly.</p>
<h4>Patient's notes</h4>
<p>Where the patient's own statement takes precedence over a clinician's or a summary's assessment (tolerance, effect, response), the record is printed exactly as the document states it and a separate <span class="pnote-label">Patient's notes on this:</span> line beneath it gives the patient's statement.</p>
<h4>Dates</h4>
<p>Dates are shown at the precision the source gave: <span class="mono">Mar 2024 ~</span> means only the month was stated. Hovering a date in the HTML shows the text as written.</p>
<h4>What this is not</h4>
<p>Nothing in this packet is a diagnosis. Findings are prompts for a clinician to look at two sources together; the ledger records what documents say and who said it, not what is true.</p>
</section>`);
  contents.push(['How to read this packet', '']);

  // --- Emergency card ------------------------------------------------------
  if (data.emergencyCard) {
    const ec = data.emergencyCard;
    const p = ec.patient;
    const intol = (x: PacketIntolerance) => `<li><strong>${esc(x.substance)}</strong>${x.reaction ? ` — ${esc(x.reaction)}` : ''}${x.severity && x.severity !== 'unknown' ? ` <span class="xs muted">(${human(x.severity)})</span>` : ''}</li>`;
    const med = (m: PacketMedication) => `<tr><td>${esc(m.name)}${m.genericName && m.genericName.toLowerCase() !== m.name.toLowerCase() ? ` <span class="muted xs">${esc(m.genericName)}</span>` : ''}</td><td>${esc([m.dose, m.unit].filter(Boolean).join(' '))}</td><td>${esc(m.route)}</td><td>${esc(m.frequency)}</td><td>${status(m.status)}</td><td>${esc(m.indication)}</td><td>${esc(m.prescriberName)}</td></tr>`;
    sections.push(`<section class="page-break emergency">
<h2>Emergency card</h2>
<div class="card">
<h1>${esc(p.name || 'Patient')}</h1>
<table class="kv"><tbody>
<tr><td>Date of birth</td><td>${esc(p.dob || '—')}</td></tr>
<tr><td>Blood type</td><td>${esc(p.bloodType || '—')}</td></tr>
<tr><td>Emergency contacts</td><td>${nl2br(p.emergencyContacts || '—')}</td></tr>
<tr><td>Generated</td><td class="mono">${esc(generated)}</td></tr>
</tbody></table>
<div class="hardstop"><div class="label">Never give</div>${ec.hardStops.length ? `<ul>${ec.hardStops.map(intol).join('')}</ul>` : '<div class="none">No hard stops are recorded in the ledger.</div>'}</div>
${ec.intolerances.length ? `<h4>Other allergies, intolerances and cautions</h4><ul class="small">${ec.intolerances.map((x) => `<li><strong>${esc(x.substance)}</strong> <span class="muted">${human(x.kind)}</span>${x.reaction ? ` — ${esc(x.reaction)}` : ''}${x.severity && x.severity !== 'unknown' ? ` (${human(x.severity)})` : ''}</li>`).join('')}</ul>` : ''}
${p.summary ? `<h4>Summary</h4><p class="summary small">${nl2br(p.summary)}</p>` : ''}
</div>
<h3>Current medications</h3>
${ec.activeMedications.length ? `<table><thead><tr><th>Medication</th><th>Dose</th><th>Route</th><th>Frequency</th><th>Status</th><th>Indication</th><th>Prescriber</th></tr></thead><tbody>${ec.activeMedications.map(med).join('')}</tbody></table>` : '<p class="muted">No active or as-needed medications are recorded.</p>'}
<h3>Diagnoses (confirmed in the ledger)</h3>
${ec.diagnoses.length ? `<p class="xs muted">Diagnosis statements the patient checked against the source. Certainty is what the source stated; ruled-out diagnoses are left out.</p><table><thead><tr><th style="width:80pt">Date</th><th>Statement</th><th style="width:64pt">Certainty</th><th>Stated by</th><th>Source</th></tr></thead><tbody>${ec.diagnoses.map((f) => `<tr><td>${date(f.date, f.datePrecision, f.dateText)}</td><td>${esc(f.statement)}${f.verdictBasis === 'summary' ? ` ${factStatus(f.status, f.verdictBasis)}` : ''}${patientNoteLine(f.patientNote, docs)}</td><td>${f.certainty ? status(f.certainty) : '<span class="muted">not stated</span>'}</td><td>${esc(f.personName)}</td><td>${refs(f.refs, docs)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No diagnosis facts are confirmed in the ledger. Working diagnoses may appear under Facts.</p>'}
<h3>Key contacts</h3>
${ec.keyContacts.length ? `<table><thead><tr><th>Name</th><th>Role</th><th>Institution</th><th>Phone</th><th>Fax</th><th>Email</th></tr></thead><tbody>${ec.keyContacts.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc([c.role, c.specialty].filter(Boolean).join(' · ') || human(c.kind))}</td><td>${esc(c.institutionName)}</td><td class="mono">${esc(c.phone)}</td><td class="mono">${esc(c.fax)}</td><td class="mono">${esc(c.email)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No contacts with a phone number or email are recorded.</p>'}
</section>`);
    contents.push(['Emergency card', `${ec.hardStops.length} hard stop${ec.hardStops.length === 1 ? '' : 's'}`]);
  }

  // --- Care team summary (request 6) ------------------------------------------
  if (data.careTeam) {
    sections.push(renderCareTeamSection(data.careTeam, generated));
    contents.push(['Care team summary', `${data.careTeam.total} on the list`]);
  }

  // --- Document index and records ------------------------------------------
  if (data.records || docs.length) {
    const rows = docs
      .map((d) => {
        const where = d.appendix === 'text' ? '<span class="muted">text section</span>' : d.packetPage != null ? `<span class="mono">p. ${d.packetPage}</span>` : opts.mode === 'pdf' ? '<span class="muted">appended</span>' : '<span class="muted">appended in the PDF</span>';
        return `<tr><td class="n">D${d.n}</td><td>${esc(d.title)}<div class="xs muted">${esc(d.filename)}</div></td><td>${date(d.documentDate, d.documentDatePrecision, d.documentDateText)}</td><td>${human(d.category)}</td><td>${esc(d.institutionName)}${d.authorName ? `<div class="xs muted">${esc(d.authorName)}</div>` : ''}</td><td class="num">${d.pageCount || (d.appendixPages ?? '')}</td><td>${where}</td></tr>`;
      })
      .join('');
    let inventory = '';
    if (data.records) {
      const inv = data.records.inventory;
      inventory = `<h3>Records inventory</h3>
<p class="small muted">Every record the ledger knows about, held or not, so the recipient can see what exists elsewhere.</p>
${inv.length ? `<table><thead><tr><th style="width:80pt">Date</th><th>Record</th><th>Type</th><th>Institution</th><th>Status</th><th>Held as</th><th>In packet</th></tr></thead><tbody>${inv
        .map((r) => `<tr><td>${date(r.recordDate, r.recordDatePrecision, r.recordDateText)}</td><td>${esc(r.title)}${r.system ? `<div class="xs muted">${esc(r.system)}</div>` : ''}</td><td>${human(r.recordType)}</td><td>${esc(r.institutionName)}</td><td>${status(r.status)}</td><td>${r.held ? esc(r.heldForm ?? 'yes') : '<span class="muted">no</span>'}</td><td>${r.docN != null ? `<span class="ref">[D${r.docN}]</span>` : r.documentTitle ? `<span class="xs muted">${esc(r.documentTitle)}</span>` : '<span class="muted">—</span>'}</td></tr>`)
        .join('')}</tbody></table>` : '<p class="muted">The inventory is empty.</p>'}
${data.records.gaps.length ? `<h3>Known gaps</h3><p class="small muted">Records that are expected, requested, refused or implied by a document but not held.</p><table><thead><tr><th style="width:80pt">Date</th><th>Record</th><th>Type</th><th>Institution</th><th>Status</th><th>Implied by</th></tr></thead><tbody>${data.records.gaps
        .map((g) => `<tr><td>${date(g.date, g.datePrecision, g.dateText)}</td><td>${esc(g.title)}</td><td>${human(g.recordType)}</td><td>${esc(g.institution)}</td><td>${status(g.status)}</td><td>${g.ref ? refTag(g.ref, docs) : '<span class="muted">inventory</span>'}</td></tr>`)
        .join('')}</tbody></table>` : ''}`;
    }
    sections.push(`<section class="page-break records">
<h2>Document index</h2>
${docs.length ? `<table><thead><tr><th>#</th><th>Document</th><th style="width:80pt">Date</th><th>Category</th><th>Institution</th><th class="num">Pages</th><th>Packet page</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No documents were selected for this packet.</p>'}
${inventory}
</section>`);
    contents.push(['Document index' + (data.records ? ' and records inventory' : ''), `${docs.length} document${docs.length === 1 ? '' : 's'}`]);
  }

  // --- Timeline --------------------------------------------------------------
  if (data.timeline) {
    const t = data.timeline;
    const window = t.from || t.to ? `${t.from ?? '…'} to ${t.to ?? '…'}` : 'whole case';
    const kinds = t.kinds && t.kinds.length ? t.kinds.map((k) => TIMELINE_KIND_LABELS[k as TimelineKind] ?? k).join(', ') : 'all kinds';
    sections.push(`<section class="page-break timeline">
<h2>Timeline</h2>
<p class="small muted">${esc(window)} · ${esc(kinds)} · ${t.items.length} entries${t.truncated ? ' (truncated)' : ''}</p>
${t.items.length ? `<table><thead><tr><th style="width:80pt">Date</th><th style="width:64pt">Kind</th><th>Entry</th><th>Detail</th><th>Who / source</th></tr></thead><tbody>${t.items
      .map((it) => `<tr><td>${date(it.date, it.datePrecision)}</td><td class="xs muted">${esc(TIMELINE_KIND_ONE[it.kind as TimelineKind] ?? it.kind)}${it.subKind ? `<br>${human(it.subKind)}` : ''}</td><td>${esc(it.title)}${it.status ? ` ${status(it.status)}` : ''}${patientNoteLine(it.patientNote, docs)}</td><td class="small">${esc(it.detail ? (it.detail.length > 220 ? `${it.detail.slice(0, 220)}…` : it.detail) : '')}</td><td class="small">${esc(it.personName)}${it.docN != null ? ` <span class="ref">[D${it.docN}]</span>` : ''}</td></tr>`)
      .join('')}</tbody></table>` : '<p class="muted">Nothing dated falls inside this window.</p>'}
</section>`);
    contents.push(['Timeline', `${t.items.length} entries`]);
  }

  // --- Facts -----------------------------------------------------------------
  if (data.factsIncluded) {
    const groups = data.factGroups
      .map(
        (g) => `<h3>${human(g.type)} <span class="muted small">(${g.facts.length})</span></h3>
<table><thead><tr><th style="width:80pt">Date</th><th>Statement</th><th style="width:70pt">Status</th><th>Source</th></tr></thead><tbody>${g.facts.map((f) => factRow(f, docs)).join('')}</tbody></table>`,
      )
      .join('');
    sections.push(`<section class="page-break facts">
<h2>Facts</h2>
<p class="small muted">${factCount} statement${factCount === 1 ? '' : 's'} · scope: ${esc(scopeLabel(config.factIds))}${config.factsFromPacketDocumentsOnly ? ' · only from the documents in this packet' : ''}</p>
${groups || '<p class="muted">No facts match this scope.</p>'}
</section>`);
    contents.push(['Facts', `${factCount}`]);
  }

  // --- Findings -------------------------------------------------------------
  if (data.findingsIncluded) {
    const blocks = data.findings
      .map(
        (f) => `<div class="finding ${esc(f.severity)}">
<div class="head"><span class="title">${esc(f.title)}</span><span class="xs muted">${human(f.category)} · ${human(f.severity)} · ${f.origin === 'rule' ? 'rule' : 'model'}</span>${status(f.status)}</div>
<div class="why">${esc(f.whyItMatters)}</div>
${f.detail ? `<div class="small">${nl2br(f.detail)}</div>` : ''}
${f.verdictNote ? `<div class="small"><span class="muted">Patient's note:</span> ${esc(f.verdictNote)}</div>` : ''}
${f.evidence.length ? `<ul>${f.evidence.map((e) => `<li><span class="xs muted">${esc(e.kind)}</span> ${esc(e.label)}${e.status ? ` ${factStatus(e.status, e.basis)}` : ''}${e.detail ? ` <span class="muted">— ${esc(e.detail)}</span>` : ''} ${e.refs.length ? refs(e.refs, docs) : ''}${patientNoteLine(e.patientNote, docs)}</li>`).join('')}</ul>` : '<div class="xs muted">No evidence rows.</div>'}
</div>`,
      )
      .join('');
    sections.push(`<section class="page-break findings">
<h2>Findings</h2>
<div class="note warn">Findings are prompts for a human look at two or more sources together. They are never diagnoses, and the patient's verdict on each is shown.</div>
${blocks || '<p class="muted">No findings match this scope.</p>'}
</section>`);
    contents.push(['Findings', `${data.findings.length}`]);
  }

  // --- Labs -------------------------------------------------------------------
  if (data.labs.length) {
    const blocks = data.labs
      .map(
        (s) => `<h3>${esc(s.analyte)} <span class="muted small">${esc(s.specimen)}${unitsHeader(s)} · ${s.rows.length} result${s.rows.length === 1 ? '' : 's'}</span></h3>
${s.svg ? `<div class="chart">${s.svg}</div>` : ''}
${s.chartNote ? `<p class="chartnote">Chart: ${esc(s.chartNote)}</p>` : ''}
<table><thead><tr><th style="width:80pt">Date</th><th class="num">Value</th><th>Unit</th><th>Reference</th><th>Flag</th><th>Lab</th><th>Source</th></tr></thead><tbody>${s.rows
          .map((r) => {
            const disputed = r.factStatus === 'disputed';
            const why = disputed && r.verdictNote ? `<div class="xs muted">note: ${esc(r.verdictNote)}</div>` : '';
            // The value, range and flag as printed (rules 1-4): a range is never built as "–50" from a single number.
            const flag = r.flagShown ?? (r.flag ? r.flag.replace('~', '') : '');
            return `<tr${disputed ? ' class="disputed"' : ''}><td>${date(r.date, r.datePrecision, r.dateText)}</td><td class="num">${esc(r.valueShown ?? r.value)}${r.splitFrom ? `<div class="xs muted">from one line: ${esc(r.splitFrom)}</div>` : ''}</td><td>${esc(r.unit)}</td><td class="mono">${esc(r.rangeShown ?? r.refText ?? '')}${r.role === 'claimed' && (r.rangeShown ?? r.refText) ? ` <span class="small muted">(this document's, not the lab's)</span>` : ''}</td><td>${flag ? `<span class="flag">${esc(flag)}</span>` : ''}</td><td class="small">${esc(r.lab ?? r.labName)}</td><td>${r.computed ? computedCell(r.computed) : r.ref ? refTag(r.ref, docs) : '<span class="muted">no source document</span>'}${r.factStatus ? ` ${factStatus(r.factStatus, r.factBasis)}` : ''}${why}</td></tr>`;
          })
          .join('')}</tbody></table>`,
      )
      .join('');
    sections.push(`<section class="page-break labs"><h2>Laboratory results</h2><p class="small muted">Values as printed in their documents, in chronological order, each with the reference range printed with it and the flag as printed ("by its range" is worked out from that range, not printed). A value written with &lt; or &gt; is a limit, not a measurement, and is never plotted. Each chart plots one unit (the most common among the results); its shaded band is drawn only when every plotted value printed the same reference range (ranges belong to the laboratory that printed them). Values in other units, values stated in summaries beside a lab report's, and disputed values are listed in the table but not plotted. A value computed by the patient from printed values (an albumin index, for example) says so with its pages; it is drawn as an open square and never judged by a range.</p>${blocks}</section>`);
    contents.push(['Laboratory results', `${data.labs.length} analyte${data.labs.length === 1 ? '' : 's'}`]);
  }

  // --- Medications -------------------------------------------------------------
  if (data.medications) {
    const m = data.medications;
    const starts = startReadings(m.medications);
    const medRows = m.medications
      .map(
        (x) => `<tr><td>${esc(x.name)}${x.genericName && x.genericName.toLowerCase() !== x.name.toLowerCase() ? `<div class="xs muted">${esc(x.genericName)}</div>` : ''}${x.drugClass ? `<div class="xs muted">${esc(x.drugClass)}</div>` : ''}</td><td>${esc([x.dose, x.unit].filter(Boolean).join(' '))}${x.route ? `<div class="xs muted">${esc(x.route)}</div>` : ''}</td><td>${esc(x.frequency)}</td><td>${status(x.status)}</td><td>${startCell(x, starts.get(x.id))}</td><td>${date(x.stopDate, x.stopDatePrecision, x.stopDateText)}</td><td class="small">${esc(x.prescriberName)}</td><td class="small">${esc(x.indication)}</td><td class="small">${esc(x.effect)}${x.reasonStopped ? `<div class="xs muted">stopped: ${esc(x.reasonStopped)}</div>` : ''}</td></tr>`,
      )
      .join('');
    const events = m.medications.filter((x) => x.events.length);
    sections.push(`<section class="page-break medications">
<h2>Medications</h2>
${m.intolerances.some((x) => x.hardStop) ? `<div class="hardstop"><div class="label">Never give</div><ul>${m.intolerances.filter((x) => x.hardStop).map((x) => `<li><strong>${esc(x.substance)}</strong>${x.reaction ? ` — ${esc(x.reaction)}` : ''}</li>`).join('')}</ul></div>` : ''}
${m.medications.length ? `<table><thead><tr><th>Medication</th><th>Dose</th><th>Frequency</th><th>Status</th><th style="width:70pt">Start</th><th style="width:70pt">Stop</th><th>Prescriber</th><th>Indication</th><th>Effect</th></tr></thead><tbody>${medRows}</tbody></table>` : '<p class="muted">No medications are recorded.</p>'}
${events.length ? `<h3>Medication events</h3><table><thead><tr><th style="width:80pt">Date</th><th>Medication</th><th>Event</th><th>Detail</th></tr></thead><tbody>${events.flatMap((x) => x.events.map((e) => `<tr><td>${date(e.date, e.datePrecision, e.dateText)}</td><td>${esc(x.name)}</td><td>${human(e.kind === 'start' && starts.get(x.id)?.startRecorded === false ? 'listed' : e.kind)}</td><td class="small">${esc([e.dose, e.detail].filter(Boolean).join(' · '))}</td></tr>`)).join('')}</tbody></table>` : ''}
<h3>Allergies, intolerances and cautions</h3>
${m.intolerances.length ? `<table><thead><tr><th>Substance</th><th>Kind</th><th>Reaction</th><th>Severity</th><th>Hard stop</th><th style="width:80pt">Date</th><th>Notes</th></tr></thead><tbody>${m.intolerances.map((x) => `<tr><td><strong>${esc(x.substance)}</strong></td><td>${human(x.kind)}</td><td>${esc(x.reaction)}</td><td>${human(x.severity)}</td><td>${x.hardStop ? '<strong>YES</strong>' : ''}</td><td>${date(x.date, x.datePrecision)}</td><td class="small">${esc(x.notes)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">None recorded.</p>'}
</section>`);
    contents.push(['Medications', `${m.medications.length}`]);
  }

  // --- Appendix: text documents -------------------------------------------------
  const textDocs = docs.filter((d) => d.appendix === 'text');
  if (textDocs.length) {
    sections.push(`<section class="page-break appendix-text">
<h2>Appendix A — documents reproduced as text</h2>
<p class="small muted">These documents are not PDFs or images; their stored page text is reproduced here exactly as extracted.</p>
${textDocs
      .map(
        (d) => `<h3>D${d.n} · ${esc(d.title)} <span class="muted small">${esc(d.filename)} · ${date(d.documentDate, d.documentDatePrecision, d.documentDateText)}</span></h3>
${d.pages.length ? d.pages.map((p) => `<div class="pagehead">D${d.n} page ${p.pageNumber}</div><pre class="pagetext">${esc(p.text)}</pre>`).join('') : '<p class="muted">No page text is stored for this document.</p>'}`,
      )
      .join('')}
</section>`);
    contents.push(['Appendix A — text documents', `${textDocs.length}`]);
  }

  // --- Appendix: originals ------------------------------------------------------
  const binDocs = docs.filter((d) => d.appendix !== 'text');
  if (binDocs.length) {
    const label = textDocs.length ? 'Appendix B — original documents' : 'Appendix — original documents';
    sections.push(`<section class="page-break appendix-originals">
<h2>${label}</h2>
<p class="small muted">${opts.mode === 'pdf' ? 'The following originals are appended after this page, in index order, each page stamped with its document number and packet page.' : 'When the PDF is generated these originals are appended after this page, in index order. This HTML version does not embed them.'}</p>
<table><thead><tr><th>#</th><th>Document</th><th style="width:80pt">Date</th><th class="num">Pages</th><th>Starts at</th></tr></thead><tbody>${binDocs
      .map((d) => `<tr><td class="n">D${d.n}</td><td>${esc(d.title)}<div class="xs muted">${esc(d.filename)} · ${esc(d.kind)}</div></td><td>${date(d.documentDate, d.documentDatePrecision, d.documentDateText)}</td><td class="num">${d.appendixPages ?? d.pageCount ?? ''}</td><td>${d.packetPage != null ? `<span class="mono">p. ${d.packetPage}</span>` : '<span class="muted">—</span>'}</td></tr>`)
      .join('')}</tbody></table>
</section>`);
    contents.push([label, `${binDocs.length}`]);
  }

  const cover = `<section class="cover">
<div class="brand">Casefile · case packet</div>
<h1>${esc(config.title)}</h1>
<table class="kv"><tbody>
${config.recipient ? `<tr><td>Prepared for</td><td>${esc(config.recipient)}</td></tr>` : ''}
${config.purpose ? `<tr><td>Purpose</td><td>${nl2br(config.purpose)}</td></tr>` : ''}
<tr><td>Patient</td><td>${esc(data.patient.name || '—')}${data.patient.dob ? ` <span class="muted">· born ${esc(data.patient.dob)}</span>` : ''}</td></tr>
<tr><td>Generated</td><td class="mono">${esc(generated)}</td></tr>
<tr><td>Contains</td><td>${esc(counts.join(' · '))}</td></tr>
</tbody></table>
${data.coverSummary ? `<div class="summary">${nl2br(data.coverSummary)}</div>` : ''}
<h4>Contents</h4>
<ul class="contents">${contents.map(([a, b]) => `<li><span>${esc(a)}</span><span>${esc(b)}</span></li>`).join('')}</ul>
<div class="footer">Assembled by Casefile from the patient's own records. Statements extracted from documents cite a source page and the originals are appended; entries marked entered by hand, no citation or no source document were recorded by the patient. Nothing here is a diagnosis.</div>
</section>`;

  const screenNote = opts.mode === 'html' ? '<div class="screen-note">No Edge or Chrome executable was found when this packet was generated, so it was stored as HTML. Open it in a browser and print to PDF (Letter) to produce the document; the originals listed in the appendix are not embedded in this file.</div>' : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="generator" content="Casefile packet export">
<title>${esc(config.title)}</title>
<style>${CSS}${data.careTeam ? CARE_TEAM_PACKET_CSS : ''}</style>
</head>
<body>
${screenNote}
<div class="sheet">
${cover}
${sections.map((s) => s).join('\n')}
</div>
</body>
</html>`;
}

function scopeLabel(scope: PacketData['config']['factIds']): string {
  if (!scope || scope === 'none') return 'none';
  if (scope === 'confirmed') return 'confirmed facts';
  if (scope === 'all') return 'all facts except superseded';
  return `${scope.length} chosen fact${scope.length === 1 ? '' : 's'}`;
}

function factRow(f: PacketFact, docs: PacketDocument[]): string {
  const end = f.dateEnd ? ` <span class="muted xs">to ${esc(formatPartialDate(f.dateEnd))}</span>` : '';
  const who = f.personName ? `<div class="xs muted">${esc(f.personName)}</div>` : '';
  const note = f.verdictNote && f.status !== 'unverified' ? `<div class="xs muted">note: ${esc(f.verdictNote)}</div>` : '';
  return `<tr><td>${date(f.date, f.datePrecision, f.dateText)}${end}</td><td>${esc(f.statement)}${who}${note}${patientNoteLine(f.patientNote, docs)}</td><td>${factStatus(f.status, f.verdictBasis)}${f.origin === 'manual' ? '<div class="xs muted">entered by hand</div>' : ''}</td><td>${refs(f.refs, docs)}</td></tr>`;
}

