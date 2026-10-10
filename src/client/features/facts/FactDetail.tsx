/**
 * One detail from a document, in the detail pane's one anatomy (docs/DESIGN.md): its check and kind (eyebrow), the
 * statement (title), one status line (its date, the document and page it came from), the actions that matter (Open the
 * page, Edit; the rest under More, Delete last), its fields as key facts (only the filled ones), then the check and
 * your answer, the quote it rests on, your note, and where it came from (closed). No stored codes, keys, model names
 * or confidence numbers on screen: the words come from ./words.ts.
 */
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '../../ui/Button';
import { Kbd } from '../../ui/Kbd';
import { Tag, FactStatusTag } from '../../ui/StatusTag';
import { CheckTag } from '../reconcile/CheckTag';
import { DateText, DateTimeText, KeepDatesWhole } from '../../ui/DateText';
import { Section } from '../../ui/PageHeader';
import { DetailHeader, DetailPane, KeyFacts, type KeyFact } from '../../ui/DetailPane';
import { Textarea } from '../../ui/Field';
import { parseAttributes, type Citation, type FactVerdictStatus, type FactWithDoc, type MergeWithFacts, type VerdictBasis } from '../../api/facts';
import type { FactDetailX as FactDetailData } from './api';
import { TrustOverride } from '../reconcile/TrustOverride';
import { ReportImpression } from '../reconcile/ReportImpression';
import { TierTag } from '../documents/tier';
import { isReconciledType } from '../../api/reconcile';
import { parseUnit } from '@shared/labvalues';
import { labAddedNote } from '@shared/labcheck';
import { MERGE_STATUS_WORDS, OBJECTIVITY_WORDS, VOICE_WORDS, alikeWords, factTypeWords, shownAttributes } from './words';

/** One plain line saying where the user's check stands. */
export function verdictLine(status: string, basis: VerdictBasis | null | undefined): string {
  if (status === 'confirmed' && basis === 'original') return 'Accurate: you checked this against the original record and it matches.';
  if (status === 'confirmed' && basis === 'summary') return 'Inferred: you have only seen this in a summary. The original is on your Records checklist to request.';
  if (status === 'confirmed' && basis === 'correction') return 'Your correction: you said the clinical record is wrong here, and this version is used.';
  if (status === 'confirmed') return 'Accepted (not compared with anything yet). Choose Accurate if it matches the original record, or Inferred if you only saw it in a summary.';
  if (status === 'unverified' && basis === 'unsure') return 'Unsure: you looked and could not tell.';
  if (status === 'disputed') return 'Incorrect: it stays on file, set aside; the clinician will not rely on it.';
  if (status === 'superseded') return "Replaced: the clinical record's value (or a newer reading) is used instead.";
  return 'Automatic: read by Claude from the document. No answer from you is needed.';
}

/** `fact_merges.reason` of the clinical-record pass's links (services/reconcile.ts): links, not duplicate proposals. */
export const CLINICAL_RECORD_LINK_REASONS: readonly string[] = ['clinical record', 'clinical record (taken back)'];

/** A fact's value in a few words: a lab or vital value with its unit, a scan's impression, else its statement. */
export function factValueWords(f: Pick<FactWithDoc, 'type' | 'statement' | 'attributesJson'>): string {
  const a = parseAttributes(f);
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
  const clipped = (t: string) => (t.length > 120 ? `${t.slice(0, 119).trimEnd()}…` : t);
  if (f.type === 'imaging_result') {
    const t = s(a.impression) || s(a.finding);
    if (t) return `"${clipped(t)}"`;
  }
  if (f.type === 'lab_result' || f.type === 'vital') {
    const v = s(a.value) || s(a.value_num);
    // A lab unit printed twice ("cells/uL cells/uL") is shown once, as on the Labs page.
    const u = f.type === 'lab_result' ? (parseUnit(s(a.unit)).unit ?? '') : s(a.unit);
    if (v) return u && !v.toLowerCase().includes(u.toLowerCase()) ? `${v} ${u}` : v;
  }
  return `"${clipped(f.statement)}"`;
}

/** The clinical-record link that sets this fact aside right now, if the clinical-record pass made it. */
export function clinicalRecordReplacement(fact: { id: string; status: string; supersededById: string | null; merges: MergeWithFacts[] }): MergeWithFacts | null {
  if (fact.status !== 'superseded' || !fact.supersededById) return null;
  return fact.merges.find((m) => m.reason === CLINICAL_RECORD_LINK_REASONS[0] && m.status === 'accepted' && m.b.id === fact.id && m.a.id === fact.supersededById) ?? null;
}

/** The status sentence on the fact pane: what replaced it when the clinical record did, else where the check stands. */
export function factStatusLine(
  fact: { id: string; status: string; supersededById: string | null; merges: MergeWithFacts[] },
  basis: VerdictBasis | null | undefined,
): string {
  const link = clinicalRecordReplacement(fact);
  if (link) return `Replaced: the clinical record (${link.a.documentTitle ?? 'a document'}) gives ${factValueWords(link.a)}, which is used instead. Choose Accurate to keep this value.`;
  return verdictLine(fact.status, basis);
}

/** Possible duplicates on the fact pane: the clinical-record pass's links are not duplicate proposals and stay out. */
export function duplicateProposals(merges: MergeWithFacts[]): MergeWithFacts[] {
  return merges.filter((m) => !CLINICAL_RECORD_LINK_REASONS.includes(m.reason));
}

export interface FactDetailProps {
  fact: FactDetailData;
  busy?: boolean;
  /** basis only counts with 'confirmed': checked against the original record, or only a summary. */
  onVerdict: (status: FactVerdictStatus, note?: string | null, basis?: VerdictBasis | null) => void;
  onEdit: () => void;
  onSupersede: () => void;
  onDelete: () => void;
  onOpenCitation: (c: Citation) => void;
  onOpenFact: (id: string) => void;
  /** Open the patient-statement picker (subjective facts only). */
  onOverride: () => void;
  onClearOverride: () => void;
}

/** How a quote was found on its page, in plain words ('none' says nothing: the tag already says not found). */
const MATCH_WORDS: Record<string, string> = { exact: 'word for word', normalized: 'same words, spacing differs', fuzzy: 'a close match' };

/** Where a detail came from, in plain words (the stored origin values stay the same). */
export const ORIGIN_WORDS: Record<string, string> = { ai: 'pulled out by Claude', manual: 'added by hand', import: 'imported', parsed: 'read off the page by the app' };

/** How sure Claude was that the statement is what the document says, in words (the number on hover). */
export function sureWords(confidence: number): string {
  if (confidence >= 0.9) return 'Very sure';
  if (confidence >= 0.7) return 'Fairly sure';
  if (confidence >= 0.5) return 'Not very sure';
  return 'Unsure';
}

/** Long fields take a whole row of the key facts. */
const WIDE_KEYS = new Set(['impression', 'finding', 'description', 'result_summary', 'action', 'detail', 'effect', 'interpretation', 'comparison', 'reason', 'reason_stopped', 'about']);

/** The first citation to open: a verified one, else the first. */
export function firstCitation(citations: Citation[]): Citation | null {
  return citations.find((c) => c.verified) ?? citations[0] ?? null;
}

export function FactDetail({ fact, busy, onVerdict, onEdit, onSupersede, onDelete, onOpenCitation, onOpenFact, onOverride, onClearOverride }: FactDetailProps) {
  const attrs = parseAttributes(fact);
  const people = Array.isArray(attrs._people) ? (attrs._people as unknown[]).map(String) : [];
  const attrError = typeof attrs._attributeError === 'string' ? attrs._attributeError : null;
  const manualOverride = attrs._overrideManual === true;
  // Mirrors the server's retirement rule (ai/extraction.ts hasUserWork): user work keeps an unverified model fact.
  // A fact the user marked unsure is user work (they looked at it), and so is one they marked "not the same event".
  const userWork =
    attrs._userEdited === true ||
    manualOverride ||
    attrs._reconcileSeparate === true ||
    Boolean(fact.verdictNote && fact.verdictNote.trim()) ||
    (fact.status === 'unverified' && fact.verdictBasis === 'unsure');
  const verified = fact.citations.filter((c) => c.verified).length;
  const [note, setNote] = useState(fact.verdictNote ?? '');
  useEffect(() => setNote(fact.verdictNote ?? ''), [fact.id, fact.verdictNote]);
  const noteDirty = note !== (fact.verdictNote ?? '');
  const canNote = fact.status !== 'superseded';
  const subjective = fact.effectiveObjectivity === 'subjective';
  const by = fact.overriddenBy;
  const basis = fact.status === 'confirmed' || (fact.status === 'unverified' && fact.verdictBasis === 'unsure') ? (fact.verdictBasis ?? null) : null;
  // Pairs of measurements, procedures or events are compared on Reconciliation, not decided as duplicates (the
  // server leaves them out of Possible duplicates too: services/facts.ts factStats, reconciledPairSql).
  const duplicates = duplicateProposals(fact.merges).filter((m) => !(isReconciledType(m.a.type) && isReconciledType(m.b.type)));
  const pendingDuplicates = duplicates.filter((m) => m.status === 'pending').length;
  const cite = firstCitation(fact.citations);
  const fields = shownAttributes(attrs, fact.type);
  const facts: KeyFact[] = fields.map((f) => ({ label: f.label, value: f.text, mono: f.data, wide: WIDE_KEYS.has(f.key) || f.text.length > 60 }));
  if (people.length) facts.push({ label: 'People named', value: people.join(', '), wide: true });
  const keepNote =
    fact.origin === 'ai' && fact.status === 'unverified'
      ? userWork
        ? 'Kept if Claude reads the document again: you answered, edited or added a note to it.'
        : 'If Claude reads the document again this detail is read afresh, unless you answer, edit it or add a note.'
      : undefined;

  return (
    <DetailPane label="Detail">
      <DetailHeader
        eyebrow={
          <>
            {fact.trust ? <CheckTag trust={fact.trust} /> : <FactStatusTag status={fact.status} basis={fact.verdictBasis} />}
            <span>{factTypeWords(fact.type)}</span>
            {fact.overriddenByFactId ? (
              <Tag tone="ash" title="Your own statement takes precedence over this one in the consult; this one is shown exactly as written">
                You say otherwise
              </Tag>
            ) : null}
          </>
        }
        title={<KeepDatesWhole text={fact.statement} />}
        titleHint={fact.statement}
        status={[
          fact.date || fact.dateText ? (
            <span key="date">
              <DateText iso={fact.date} precision={fact.datePrecision} text={fact.dateText} />
              {fact.dateEnd ? (
                <>
                  {' '}
                  to <DateText iso={fact.dateEnd} />
                </>
              ) : null}
            </span>
          ) : (
            <span key="date">no date given</span>
          ),
          fact.document ? (
            <span key="doc">
              from{' '}
              <Link to="/documents/$id" params={{ id: fact.document.id }} search={cite ? { page: cite.pageNumber, cite: cite.id } : undefined}>
                {fact.document.title}
              </Link>
              {cite ? `, p.${cite.pageNumber}` : ''}
            </span>
          ) : (
            <span key="doc">{ORIGIN_WORDS[fact.origin] ?? 'no document'}</span>
          ),
          fact.assertedBy === 'patient' ? <span key="voice">in your own words</span> : null,
        ]}
        actions={{
          primary: cite ? { label: 'Open the page', onClick: () => onOpenCitation(cite), shortcut: 'enter', title: 'The page this detail was read from, with the passage marked' } : null,
          secondary: [{ label: 'Edit', onClick: onEdit, shortcut: 'e', disabled: busy, title: 'Change the statement, its date or its fields' }],
          more: [
            { label: 'Replaced by a newer one…', onClick: onSupersede, shortcut: 's', disabled: busy, title: 'Pick the newer detail that replaces this one; this one stays on file, marked replaced' },
            subjective
              ? { label: fact.overriddenByFactId ? 'Change what you say…' : 'You say otherwise…', onClick: onOverride, shortcut: 'o', disabled: busy, title: "Pick or type what you say instead; this one is kept as written and Claude goes by your statement" }
              : null,
            by ? { label: "Stop using your statement", onClick: onClearOverride, disabled: busy, title: "Go back to this detail as written; your statement stays on file" } : null,
            'separator',
            { label: 'Delete…', onClick: onDelete, shortcut: 'Delete', danger: true, disabled: busy, title: 'Hide this detail everywhere (asks first; it is not erased)' },
          ],
        }}
        facts={facts}
      />

      {attrError ? <div className="notice warn small">Some of this detail’s fields could not be read ({attrError}). Edit it to put them right.</div> : null}

      {by ? (
        <Section
          title="You say otherwise"
          actions={
            <Button size="sm" onClick={() => onOpenFact(by.id)}>
              Open your statement
            </Button>
          }
        >
          <KeyFacts
            items={[
              {
                label: 'You say',
                value: (
                  <span>
                    <q className="facts-quote">{by.statement}</q>{' '}
                    <span className="muted small">
                      (<DateText iso={by.date} precision={by.datePrecision} />
                      {by.documentTitle ? `, ${by.documentTitle}` : ', added by hand'})
                    </span>
                  </span>
                ),
                wide: true,
              },
              { label: 'Why', value: `${fact.overrideReason ?? 'No reason given'}${manualOverride ? ' (set by hand)' : ''}`, wide: true },
              { label: 'What it means', value: <span className="muted">Claude goes by your statement and mentions this one as background. This one is kept exactly as written and shown everywhere.</span>, wide: true },
            ]}
          />
        </Section>
      ) : null}

      <Section title="Check" intro="How this detail compares with your clinical records. Give your own answer only when you know better.">
        {fact.trust ? (
          <TrustOverride
            factId={fact.id}
            trust={fact.trust}
            status={fact.status}
            basis={fact.verdictBasis}
            reconciled={isReconciledType(fact.type)}
            documentTier={fact.document ? (fact.document.sourceTier ?? undefined) : null}
            separated={attrs._reconcileSeparate === true}
            withSummary
          />
        ) : (
          <p className="facts-line">{factStatusLine(fact, basis)}</p>
        )}
        {/* A scan not compared with its report: the report's whole impression, to read beside this one. */}
        {fact.type === 'imaging_result' ? <ReportImpression factId={fact.id} trust={fact.trust} /> : null}
      </Section>

      <Section title="The quote it rests on" count={fact.citations.length ? `${verified} of ${fact.citations.length} found on the page` : undefined}>
        {fact.citations.length ? (
          <div className="cite-list">
            {fact.citations.map((c) => (
              <button key={c.id} type="button" className="cite-row" onClick={() => onOpenCitation(c)} title="Open the page with this passage marked">
                <span className="page">p.{c.pageNumber}</span>
                <span className="quote">{c.quote}</span>
                <span className="state">
                  <Tag tone={c.verified ? 'ok' : 'warn'}>{c.verified ? 'found on the page' : 'not found on the page'}</Tag>
                  {c.matchKind === 'mismatch' ? (
                    <span className="cite-match" title="A passage like the quote is on the page, but its numbers differ from the quote's: check the value against the page">
                      the numbers differ
                    </span>
                  ) : c.matchKind && MATCH_WORDS[c.matchKind] ? (
                    <span className="cite-match">{MATCH_WORDS[c.matchKind]}</span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="section-intro">{fact.origin === 'manual' ? 'Added by hand, with no quote.' : 'No quote was kept for this detail.'}</p>
        )}
      </Section>

      {fact.overrides.length ? (
        <Section title="Takes precedence over" count={fact.overrides.length}>
          <div className="override-list">
            {fact.overrides.map((o) => (
              <button key={o.id} type="button" className="btn ghost sm facts-link-button" onClick={() => onOpenFact(o.id)} title="Open that detail">
                {o.statement}
                <span className="muted"> · {o.documentTitle ?? 'added by hand'}</span>
              </button>
            ))}
          </div>
        </Section>
      ) : null}

      <Section
        title="Your note"
        intro={keepNote}
        actions={
          canNote ? (
            // Keeps the current answer, including whether it was checked against the original or a summary.
            <Button size="sm" disabled={busy || !noteDirty} onClick={() => onVerdict(fact.status as FactVerdictStatus, note, basis)}>
              Save note
            </Button>
          ) : null
        }
      >
        <div className="verdict-note">
          <Textarea aria-label="Your note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Matches the lab report I have on paper; ask Dr A. Example about the date." disabled={!canNote} rows={3} />
        </div>
      </Section>

      {fact.supersededBy || fact.supersedes.length ? (
        <Section title="Replaced">
          <KeyFacts
            items={[
              fact.supersededBy
                ? {
                    label: 'Replaced by',
                    value: (
                      <button type="button" className="btn ghost sm facts-link-button" onClick={() => onOpenFact(fact.supersededBy!.id)}>
                        {fact.supersededBy.statement}
                      </button>
                    ),
                    wide: true,
                  }
                : null,
              ...fact.supersedes.map((s) => ({
                label: 'Replaces',
                value: (
                  <button type="button" className="btn ghost sm facts-link-button" onClick={() => onOpenFact(s.id)}>
                    {s.statement}
                  </button>
                ),
                wide: true,
              })),
            ]}
          />
        </Section>
      ) : null}

      {duplicates.length ? (
        <Section title="Possible duplicates" count={duplicates.length} intro={pendingDuplicates ? 'Decide them under View: Possible duplicates, above the list.' : undefined}>
          <div className="facts-dupes">
            {duplicates.map((m) => {
              const other = m.a.id === fact.id ? m.b : m.a;
              const st = MERGE_STATUS_WORDS[m.status] ?? { label: m.status, tone: 'ash' as const };
              return (
                <div key={m.id} className="facts-dupe">
                  <span className="mono muted">{alikeWords(m.similarity)}</span>
                  <span className="facts-dupe-what">
                    <button type="button" className="btn ghost sm facts-link-button" onClick={() => onOpenFact(other.id)}>
                      {other.statement}
                    </button>
                    <span className="muted small">
                      {other.documentTitle ?? 'added by hand'} · {m.reason}
                    </span>
                  </span>
                  <Tag tone={st.tone}>{st.label}</Tag>
                </div>
              );
            })}
          </div>
          {pendingDuplicates ? (
            <p className="section-intro">
              There, <Kbd>a</Kbd> keeps the first, <Kbd>b</Kbd> the second and <Kbd>r</Kbd> keeps both.
            </p>
          ) : null}
        </Section>
      ) : null}

      {/* Closed by default: which document, whose words, when it was read and checked. */}
      <details className="facts-origin">
        <summary>Where this came from</summary>
        <KeyFacts
          items={[
            {
              label: 'Document',
              value: fact.document ? (
                <Link to="/documents/$id" params={{ id: fact.document.id }}>
                  {fact.document.title}
                </Link>
              ) : (
                <span className="muted">none</span>
              ),
              wide: true,
            },
            fact.document ? { label: 'Kind of document', value: <TierTag tier={fact.document.sourceTier ?? 'unknown'} /> } : null,
            { label: 'Whose words', value: VOICE_WORDS[fact.assertedBy] ?? 'Not known' },
            { label: 'What kind of statement', value: `${OBJECTIVITY_WORDS[fact.effectiveObjectivity] ?? fact.effectiveObjectivity}${fact.objectivity === 'unknown' ? ' (usual for this kind of detail)' : ''}` },
            { label: 'Added', value: <span>{labAddedNote(attrs)?.replace(/\.$/, '') ?? (ORIGIN_WORDS[fact.origin] ?? fact.origin).replace(/^./, (c) => c.toUpperCase())}, <DateTimeText iso={fact.createdAt} /></span>, wide: Boolean(labAddedNote(attrs)) },
            fact.origin === 'ai' ? { label: 'How sure Claude was', value: sureWords(fact.confidence), title: `That this is what the document says (${fact.confidence.toFixed(2)} out of 1)` } : null,
            fact.run ? { label: 'Read', value: <span><DateTimeText iso={fact.run.startedAt} />{fact.run.deep ? ', a deep reading' : ''}</span> } : null,
            fact.verdictAt ? { label: 'You answered', value: <DateTimeText iso={fact.verdictAt} /> } : null,
            fact.personId ? { label: 'Person', value: <Link to="/people" search={{ id: fact.personId }}>Open in People and places</Link> } : null,
          ]}
        />
      </details>
    </DetailPane>
  );
}
