/**
 * One upload waiting to be checked before it is filed, in the detail pane's one anatomy (docs/DESIGN.md): where it
 * stands (eyebrow), the title it will be filed under (title), the file and its pages (status line), File it with Ask
 * Claude again, Skip and Open the document (actions), a few key facts, then Claude's suggestion (what it is, why, the
 * key points with their pages), the form "File as" (every field editable, in plain words), what filing will also do,
 * and the first page's text. No stored codes, model names, ids or confidence numbers on screen.
 *
 * Every field starts from Claude's suggestion (or the document's current values when there is none) and the user can
 * change any of it; File it sends the resolved overrides, the chosen links and the ticked actions.
 */
import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { DOCUMENT_CATEGORIES, SOURCE_TIERS } from '@shared/enums';
import { parsePartialDate } from '@shared/dates';
import { TRIAGE_ACTIONS, type TriageAction } from '@shared/schemas/inbox';
import { canFileItem, canSkipItem, isReading, type EncounterLite, type FileInboxInput, type InboxItem } from '../../api/inbox';
import { DOCUMENT_TYPE_LABELS, documentTypeLabel } from '../../api/filing';
import type { PersonRow } from '../../api/people';
import type { RecordRow } from '../../api/records';
import { Kbd } from '../../ui/Kbd';
import { DateText, DateTimeText } from '../../ui/DateText';
import { Section } from '../../ui/PageHeader';
import { DetailHeader, DetailPane, type KeyFact } from '../../ui/DetailPane';
import { Input, Select } from '../../ui/Field';
import { TIER_ORDER, TierTag, tierWords } from '../documents/tier';
import { friendlyReason } from '../filing/Filing';
import { InboxStatusTag } from './status';
import { ACTION_WORDS, AUTHOR_ROLE_WORDS, CONTAINS_WORDS, FIELD_WORDS, FILE_KIND_WORDS, INBOX_NAME, filedParts, sureWords } from './words';

export interface InboxDetailProps {
  item: InboxItem;
  people: PersonRow[];
  records: RecordRow[];
  encounters: EncounterLite[];
  aiOff: boolean;
  busy: boolean;
  /** Bumped by the page when the user presses e: focus the title field. */
  focusToken: number;
  /** The page reads the current form through this so Enter in the list files what was edited. */
  builderRef?: MutableRefObject<(() => FileInboxInput) | null>;
  onFile: (input: FileInboxInput) => void;
  onRetriage: () => void;
  onSkip: () => void;
  onOpen: () => void;
}

/** Actions the form shows as checkboxes; create_person is implied by the "new" name fields. */
const SHOWN_ACTIONS: TriageAction[] = TRIAGE_ACTIONS.filter((a) => a !== 'create_person');

function isInstitution(p: PersonRow): boolean {
  return p.kind === 'institution' || p.kind === 'clinic';
}

const TEXT_STATUS_WORDS: Record<string, string> = {
  pending: 'waiting to be read',
  extracting: 'reading the pages',
  extracted: 'read',
  ocr_needed: 'scanned pages: needs a closer read',
  ocr_running: 'reading the scanned pages',
  ocr_done: 'read (scanned pages)',
  failed: 'could not be read',
};
const RECORD_STATUS_WORDS: Record<string, string> = { expected: 'expected', requested: 'asked for', received: 'received', unknown: 'not known', not_held: 'not held', denied: 'refused' };

export function InboxDetail({ item, people, records, encounters, aiOff, busy, focusToken, builderRef, onFile, onRetriage, onSkip, onOpen }: InboxDetailProps) {
  const t = item.triage;
  const inbox = item.inbox;
  const status = inbox?.status ?? null;
  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  const initialDate = t?.document_date ?? item.documentDateText ?? item.documentDate ?? '';
  /** The tier on the document now (the classification sets it while it is unknown); the form starts from it. */
  const currentTier = item.sourceTier ?? t?.source_tier ?? 'unknown';
  const [title, setTitle] = useState(t?.title ?? item.title);
  const [category, setCategory] = useState<string>(t?.category ?? item.category);
  const [tier, setTier] = useState<string>(currentTier);
  const [dateText, setDateText] = useState(initialDate);
  const [instId, setInstId] = useState<string>(t?.institution.match_id ?? item.institutionId ?? '');
  const [instNew, setInstNew] = useState<string>(t?.institution.match_id ? '' : (t?.institution.new_name ?? ''));
  const [authorId, setAuthorId] = useState<string>(t?.author.match_id ?? item.authorPersonId ?? '');
  const [authorNew, setAuthorNew] = useState<string>(t?.author.match_id ? '' : (t?.author.new_name ?? ''));
  const [actions, setActions] = useState<Set<TriageAction>>(() => new Set(t?.suggested_actions ?? []));
  const [encounterId, setEncounterId] = useState<string>(t?.suggested_links.encounter_id ?? '');
  const [rowIds, setRowIds] = useState<Set<string>>(() => new Set(t?.suggested_links.inventory_row_ids ?? []));

  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusToken > 0) titleRef.current?.focus();
  }, [focusToken]);
  const parsedDate = useMemo(() => parsePartialDate(dateText), [dateText]);

  const institutions = useMemo(() => people.filter(isInstitution).sort((a, b) => a.name.localeCompare(b.name)), [people]);
  const authors = useMemo(() => people.filter((p) => !isInstitution(p)).sort((a, b) => a.name.localeCompare(b.name)), [people]);
  const openRecords = useMemo(() => {
    const proposed = new Set(t?.suggested_links.inventory_row_ids ?? []);
    return records.filter((r) => proposed.has(r.id) || r.status === 'expected' || r.status === 'requested');
  }, [records, t]);
  const encounterOptions = useMemo(() => {
    const list = encounters.map((e) => ({ value: e.id, label: `${e.occurredAt ?? 'no date'} · ${e.title}` }));
    if (encounterId && !encounters.some((e) => e.id === encounterId)) list.unshift({ value: encounterId, label: 'The appointment Claude suggested (not listed)' });
    return list;
  }, [encounters, encounterId]);

  function toggleAction(a: TriageAction) {
    setActions((s) => {
      const n = new Set(s);
      if (n.has(a)) n.delete(a);
      else n.add(a);
      return n;
    });
  }
  function toggleRow(id: string) {
    setRowIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function buildInput(): FileInboxInput {
    const overrides: NonNullable<FileInboxInput['overrides']> = {};
    if (title.trim()) overrides.title = title.trim();
    if (category) overrides.category = category as (typeof DOCUMENT_CATEGORIES)[number];
    // Only a changed tier is sent: filing then records it as the user's correction.
    if (tier !== currentTier && (SOURCE_TIERS as readonly string[]).includes(tier)) overrides.sourceTier = tier as (typeof SOURCE_TIERS)[number];
    if (dateText.trim()) overrides.documentDateText = dateText.trim();
    else if (initialDate) overrides.documentDateText = null;
    if (instNew.trim()) overrides.newInstitutionName = instNew.trim();
    else if (instId) overrides.institutionId = instId;
    else if (t?.institution.match_id || t?.institution.new_name || item.institutionId) overrides.institutionId = null;
    if (authorNew.trim()) overrides.newAuthorName = authorNew.trim();
    else if (authorId) overrides.authorPersonId = authorId;
    else if (t?.author.match_id || t?.author.new_name || item.authorPersonId) overrides.authorPersonId = null;
    const chosen = new Set(actions);
    if (instNew.trim() || authorNew.trim()) chosen.add('create_person');
    else chosen.delete('create_person');
    const linkEncounter = chosen.has('link_encounter') && Boolean(encounterId);
    if (!linkEncounter) chosen.delete('link_encounter');
    const receive = chosen.has('mark_record_received') && rowIds.size > 0;
    if (!receive) chosen.delete('mark_record_received');
    return {
      overrides,
      actions: [...chosen],
      encounterId: linkEncounter ? encounterId : null,
      inventoryRowIds: receive ? [...rowIds] : [],
    };
  }

  if (builderRef) builderRef.current = buildInput;
  useEffect(() => {
    return () => {
      if (builderRef) builderRef.current = null;
    };
  }, [builderRef]);

  const reading = isReading(item);
  const canFile = canFileItem(item);
  const canSkip = canSkipItem(item);
  // The server refuses re-triage until the text is in (pending covers a queued or cancelled extraction).
  const canRetriage = !reading && item.textStatus !== 'pending';
  const peopleMentioned = t?.people_mentioned ?? [];
  const linkedPeople = (t?.suggested_links.person_ids ?? []).map((id) => peopleById.get(id)?.name).filter((n): n is string => Boolean(n));
  const filing = inbox?.filing ?? null;
  const keyPoints = t?.key_points ?? [];
  const authorRole = item.authorRole ?? t?.author_role ?? null;
  const tierFromModel = Boolean(t && t.source_tier === currentTier && currentTier !== 'unknown');
  /** The stored classification is newer than the one the item was filed from (a later Re-title or re-ingest). */
  const proposalIsLater = Boolean(t && filing?.proposal && (filing.proposal.at !== t.at || filing.proposal.callId !== (t.callId ?? null)));
  const contains = t ? Object.entries(t.contains).filter(([, v]) => v).map(([k]) => CONTAINS_WORDS[k] ?? k.replace(/_/g, ' ')) : [];

  let notice: ReactNode = null;
  if (!inbox) {
    notice = <div className="notice small">This document is already in the case and is not waiting here; nothing was added. Open it, or Classify it to bring it here and file it.</div>;
  } else if (status === 'new') {
    notice = (
      <div className="notice small">
        {item.textStatus === 'failed' ? (
          <>The text could not be read{item.textError ? ` (${friendlyReason(item.textError)})` : ''}. Fill in the fields and file it by hand, or read it again from Documents.</>
        ) : item.textStatus === 'pending' && item.textError ? (
          <>Reading the text stopped ({friendlyReason(item.textError)}). Read it again from Documents, or fill in the fields and file it by hand.</>
        ) : !item.pageCount || reading ? (
          <>Reading the file ({TEXT_STATUS_WORDS[item.textStatus] ?? 'in progress'})…</>
        ) : aiOff ? (
          <>Claude is switched off, so there is no suggestion. Fill in the fields below and file it by hand.</>
        ) : (
          <>Claude is working out where it goes; the suggestion appears here when it is ready.</>
        )}
      </div>
    );
  } else if (status === 'needs_manual') {
    notice = <div className="notice warn small">No suggestion from Claude{inbox.error ? ` (${friendlyReason(inbox.error)})` : ''}. Fill in the fields below and File it, or Ask Claude again once Claude is available.</div>;
  } else if (status === 'filed') {
    const parts = filing ? filedParts(filing) : [];
    const fields = filing ? [...new Set(Object.keys(filing.fields).map((k) => FIELD_WORDS[k] ?? k))] : [];
    notice = (
      <div className="notice ok small filing-record">
        Filed <DateTimeText iso={filing?.at ?? inbox.filedAt} />. Ask Claude again brings it back here; nothing was deleted.
        {filing ? (
          <ul>
            {filing.proposal ? <li>From Claude’s suggestion of <DateTimeText iso={filing.proposal.at} />{proposalIsLater ? '; the suggestion below is a later one' : ''}</li> : filing.proposal === null ? <li>Filed by hand, without a suggestion</li> : null}
            {fields.length ? <li>Set: {fields.join(', ')}</li> : null}
            {parts.filter((p) => !/warning/.test(p)).map((p) => (
              <li key={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</li>
            ))}
            {filing.warnings.map((w) => (
              <li key={w} className="text-warn">
                {w}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  } else if (status === 'skipped') {
    notice = <div className="notice small">Skipped: it stays in Documents as it is. Ask Claude again brings it back here.</div>;
  }
  // A re-ingest of an item past `new` (or of a filed one): filing and skipping wait for the text.
  const readingNotice = reading && inbox && status !== 'new' ? <div className="notice small">Reading the file again ({TEXT_STATUS_WORDS[item.textStatus] ?? 'in progress'}). Filing and skipping wait until the text is in.</div> : null;

  const facts: KeyFact[] = [
    { label: 'Added', value: <DateTimeText iso={inbox?.receivedAt || item.createdAt} /> },
    { label: 'File', value: `${FILE_KIND_WORDS[item.kind] ?? item.kind}, ${Math.max(1, Math.round(item.sizeBytes / 1024))} KB` },
    t ? { label: 'How sure Claude is', value: sureWords(t.confidence), title: `${t.confidence.toFixed(2)} out of 1` } : null,
    item.sourceTier || t ? { label: 'Kind of document', value: <TierTag tier={currentTier} />, title: tierFromModel ? 'Suggested by Claude and already set on the document; change it under File as' : undefined } : null,
    authorRole ? { label: 'Written by', value: AUTHOR_ROLE_WORDS[authorRole] ?? authorRole.replace(/_/g, ' ') } : null,
    item.institutionName ? { label: 'Institution now', value: item.institutionName } : null,
    item.authorName ? { label: 'Author now', value: item.authorName } : null,
  ].filter(Boolean) as KeyFact[];

  return (
    <DetailPane label={INBOX_NAME} className="inbox-detail">
      <DetailHeader
        eyebrow={
          <>
            <InboxStatusTag item={item} />
            <span>{t || item.category !== 'other' ? documentTypeLabel(category) : 'Upload'}</span>
          </>
        }
        title={title.trim() || item.title}
        titleHint={title.trim() || item.title}
        status={[
          <span key="file" className="mono" title="The file name as uploaded">
            {item.filename}
          </span>,
          `${item.pageCount} page${item.pageCount === 1 ? '' : 's'}`,
          item.textStatus !== 'extracted' ? (TEXT_STATUS_WORDS[item.textStatus] ?? null) : null,
        ]}
        actions={
          inbox
            ? {
                primary: { label: 'File it', onClick: () => onFile(buildInput()), shortcut: 'enter', disabled: busy || !canFile, title: 'File it as the form below says (Ctrl+Enter from any field)' },
                secondary: [
                  { label: 'Ask Claude again', onClick: onRetriage, shortcut: 'r', disabled: busy || !canRetriage, title: 'Claude reads it again and makes a new suggestion' },
                  { label: 'Skip', onClick: onSkip, shortcut: 's', disabled: busy || !canSkip, title: 'Leave it in Documents as it is, without filing' },
                ],
                more: [{ label: 'Open the document', onClick: onOpen, shortcut: 'o' }],
              }
            : {
                primary: { label: 'Classify it', onClick: onRetriage, shortcut: 'r', disabled: busy || !canRetriage, title: 'Bring it here and let Claude suggest where it goes' },
                secondary: [{ label: 'Open the document', onClick: onOpen, shortcut: 'o' }],
              }
        }
        facts={facts}
      />

      {notice}
      {readingNotice}

      {t ? (
        <Section title="Claude’s suggestion">
          <p className="proposal-summary">{t.summary}</p>
          <p className="proposal-why">
            <span className="muted">Why: </span>
            {t.why}
          </p>
          {keyPoints.length ? (
            <div className="proposal-points-block">
              <span className="section-intro">Key points, each with the page it rests on</span>
              <ol className="proposal-points">
                {keyPoints.map((k, i) => (
                  <li key={i}>
                    <span>{k.text}</span>
                    {k.page ? (
                      <Link
                        to="/documents/$id"
                        params={{ id: item.id }}
                        search={{ page: k.page, q: k.quote && k.quote.length <= 120 ? k.quote : undefined, tab: 'text' }}
                        className={`proposal-chip${k.verified === false ? ' unverified' : ''}`}
                        title={k.quote ? `"${k.quote}"${k.verified === false ? ' (not found word for word on that page)' : ''}` : undefined}
                      >
                        p.{k.page}
                        {k.verified === false ? ', not found' : ''}
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          <p className="proposal-line">
            <span className="muted">It holds: </span>
            {contains.length ? contains.join(', ') : 'nothing in particular'}
            {peopleMentioned.length ? (
              <>
                <span className="muted"> · People named: </span>
                {peopleMentioned.join(', ')}
              </>
            ) : null}
            {linkedPeople.length ? (
              <>
                <span className="muted"> · Already in People and places: </span>
                {linkedPeople.join(', ')}
              </>
            ) : null}
          </p>
          <p className="section-intro">
            Suggested <DateTimeText iso={t.at} />, from {t.pagesUsed} page{t.pagesUsed === 1 ? '' : 's'}.
          </p>
        </Section>
      ) : null}

      {inbox ? (
        <>
          <Section title={t ? 'File as' : 'File by hand'} intro={t ? "Start from Claude’s suggestion and change anything; File it uses what is here." : "Fill in where it goes; File it uses what is here."}>
            <div
              className="proposal-form"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canFile && !busy) {
                  e.preventDefault();
                  onFile(buildInput());
                }
              }}
            >
              <label htmlFor="inbox-title">Title</label>
              <input id="inbox-title" ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} />
              <label htmlFor="inbox-category">Type</label>
              <Select id="inbox-category" value={category} options={DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: DOCUMENT_TYPE_LABELS[c] ?? c }))} onChange={(e) => setCategory(e.target.value)} />
              <label htmlFor="inbox-tier">Kind of document</label>
              <span className="proposal-with-note">
                <Select id="inbox-tier" value={tier} options={TIER_ORDER.map((v) => ({ value: v, label: tierWords(v).label }))} onChange={(e) => setTier(e.target.value)} title={tierWords(tier).title} />
                {tier !== currentTier ? <span className="muted small nowrap">was {tierWords(currentTier).label}</span> : tierFromModel ? <span className="muted small nowrap">Claude’s suggestion</span> : null}
              </span>
              <label htmlFor="inbox-date">Date as written</label>
              <span className="proposal-with-note">
                <Input id="inbox-date" value={dateText} onChange={(e) => setDateText(e.target.value)} placeholder="e.g. 3/11/2024, March 2024" />
                {dateText.trim() ? parsedDate.iso ? <DateText iso={parsedDate.iso} precision={parsedDate.precision} /> : <span className="muted small nowrap">not a date; kept as written</span> : null}
              </span>
              <label htmlFor="inbox-inst">Institution</label>
              <span className="or-new">
                <Select
                  id="inbox-inst"
                  aria-label="Institution already listed"
                  value={instId}
                  options={institutions.map((p) => ({ value: p.id, label: p.name }))}
                  placeholder={instNew.trim() ? 'A new one (typed beside)' : 'None'}
                  onChange={(e) => {
                    setInstId(e.target.value);
                    if (e.target.value) setInstNew('');
                  }}
                />
                <Input aria-label="Or a new institution" value={instNew} onChange={(e) => setInstNew(e.target.value)} placeholder={instId ? 'or type a new one' : 'e.g. Neurology Clinic'} title="A name typed here is matched to an institution already listed, or added when you file" />
              </span>
              <label htmlFor="inbox-author">Author</label>
              <span className="or-new">
                <Select
                  id="inbox-author"
                  aria-label="Author already listed"
                  value={authorId}
                  options={authors.map((p) => ({ value: p.id, label: `${p.name}${p.kind !== 'clinician' ? ` (${p.kind.replace(/_/g, ' ')})` : ''}` }))}
                  placeholder={authorNew.trim() ? 'A new one (typed beside)' : 'None'}
                  onChange={(e) => {
                    setAuthorId(e.target.value);
                    if (e.target.value) setAuthorNew('');
                  }}
                />
                <Input aria-label="Or a new author" value={authorNew} onChange={(e) => setAuthorNew(e.target.value)} placeholder={authorId ? 'or type a new one' : 'e.g. Dr A. Example'} title="A name typed here is matched to a person already listed, or added when you file" />
              </span>
            </div>
            <span className="muted small">
              <Kbd>ctrl+enter</Kbd> files it from any field
            </span>
          </Section>

          <Section title="Filing will also">
            <div className="check-list">
              {SHOWN_ACTIONS.filter((a) => a !== 'link_encounter' && a !== 'mark_record_received').map((a) => (
                <label key={a} className={actions.has(a) ? '' : 'off'}>
                  <input type="checkbox" checked={actions.has(a)} onChange={() => toggleAction(a)} />
                  <span>{ACTION_WORDS[a]}</span>
                  {t?.suggested_actions.includes(a) ? <span className="meta">suggested</span> : null}
                  {a === 'create_communication' ? <span className="meta">its summary is marked as Claude’s</span> : null}
                </label>
              ))}
              <label className={actions.has('link_encounter') ? '' : 'off'}>
                <input type="checkbox" checked={actions.has('link_encounter')} onChange={() => toggleAction('link_encounter')} disabled={!encounterOptions.length} />
                <span>{ACTION_WORDS.link_encounter}</span>
                {encounterOptions.length ? <Select aria-label="Appointment" value={encounterId} options={encounterOptions} placeholder="Choose one" onChange={(e) => setEncounterId(e.target.value)} /> : <span className="meta">no appointments to link</span>}
              </label>
              <label className={actions.has('mark_record_received') ? '' : 'off'}>
                <input type="checkbox" checked={actions.has('mark_record_received')} onChange={() => toggleAction('mark_record_received')} disabled={!openRecords.length} />
                <span>{ACTION_WORDS.mark_record_received}</span>
                {openRecords.length ? null : <span className="meta">none expected or asked for</span>}
              </label>
              {openRecords.length ? (
                <div className="check-list check-list-sub">
                  {openRecords.map((r) => (
                    <label key={r.id} className={rowIds.has(r.id) ? '' : 'off'}>
                      <input type="checkbox" checked={rowIds.has(r.id)} onChange={() => toggleRow(r.id)} disabled={!actions.has('mark_record_received')} />
                      <span>{r.title}</span>
                      <span className="meta">
                        {r.recordType.replace(/_/g, ' ')} · {RECORD_STATUS_WORDS[r.status] ?? r.status.replace(/_/g, ' ')}
                        {r.institutionName ? ` · ${r.institutionName}` : ''}
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
              {instNew.trim() || authorNew.trim() ? (
                <span className="muted small">
                  The new {[instNew.trim() ? `institution "${instNew.trim()}"` : null, authorNew.trim() ? `author "${authorNew.trim()}"` : null].filter(Boolean).join(' and ')} will be matched by name or added to People and places.
                </span>
              ) : null}
            </div>
          </Section>
        </>
      ) : null}

      <Section title="First page">
        {item.firstPageSnippet ? (
          <pre className="inbox-snippet">
            {item.firstPageSnippet}
            {item.firstPageSnippet.length >= 790 ? '\n…' : ''}
          </pre>
        ) : (
          <p className="section-intro">{item.pageCount ? 'The first page has no text.' : 'No page text yet.'}</p>
        )}
      </Section>
    </DetailPane>
  );
}
