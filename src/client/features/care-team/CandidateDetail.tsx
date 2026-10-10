/**
 * Right pane of /care-team: one candidate. The title and one status line, the actions, the facts (each "not backed
 * yet" until a source holds it, and "unverified" while only a web search says it), "Verified by phone", then the Flare
 * test with its Pass or Fail, the sources, calls and messages, to-dos and the status history. A proposal from the web
 * says so first, with its links, and offers Yes and No.
 */
import { Link } from '@tanstack/react-router';
import { Tag } from '../../ui/StatusTag';
import { DateText, DateTimeText } from '../../ui/DateText';
import { DetailHeader, DetailPane, type KeyFact } from '../../ui/DetailPane';
import { Section } from '../../ui/PageHeader';
import { Button } from '../../ui/Button';
import type { ActionBarProps } from '../../ui/ActionBar';
import {
  FIELD_WORDS,
  FLARE_TEST_ITEMS,
  FLARE_VERDICT_HINT,
  FLARE_VERDICT_WORDS,
  NOT_BACKED_TITLE,
  NOT_BACKED_WORDS,
  SOURCED_FIELDS,
  UNVERIFIED_TITLE,
  UNVERIFIED_WORDS,
  callWords,
  fieldWords,
  flareBacking,
  normalizeWebsite,
  stepWords,
  type Backing,
  type CareSource,
  type PhoneCheck,
  type SourcedField,
  type Verification,
} from '@shared/care-team';
import type { CandidateDetail as Detail } from '../../api/care-team';
import { STATUS_TONE, VERDICT_TONE, flareWords, placeWords, roleWords, statusWords } from './words';

export interface CandidateDetailProps {
  candidate: Detail;
  busy?: boolean;
  /** Owners and editors: everything. Viewers: read, log calls and to-dos. */
  canWrite: boolean;
  onEdit: () => void;
  onStatus: () => void;
  onFlare: (item?: string) => void;
  onSource: () => void;
  onRemoveSource: (sourceId: string) => void;
  onLogCall: () => void;
  onTask: () => void;
  onAccept: () => void;
  onReject: () => void;
  onLinkPerson: () => void;
  onDelete: () => void;
  /** Request 6: the verdict on the flare test (Pass or Fail, with why). */
  onVerdict?: () => void;
  /** Request 6: the home-state license row edits the "Licensed in home state" fact. */
  onHomeState?: () => void;
  /** Request 6: tick "Verified by phone" (asks who called and when) or untick it. */
  onPhoneCheck?: () => void;
  onPhoneUncheck?: () => void;
  /** A tick just taken back: Undo puts it back. */
  undone?: PhoneCheck[] | null;
  onUndo?: () => void;
}

function BackTag({ b, v }: { b: Backing; v?: Verification }) {
  if (b === 'not_backed')
    return (
      <Tag tone="neutral" title={NOT_BACKED_TITLE}>
        {NOT_BACKED_WORDS}
      </Tag>
    );
  if (v === 'unverified')
    return (
      <Tag tone="neutral" title={UNVERIFIED_TITLE}>
        {UNVERIFIED_WORDS}
      </Tag>
    );
  return null;
}

function ExternalLink({ url, children }: { url: string; children?: React.ReactNode }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow">
      {children ?? normalizeWebsite(url)}
    </a>
  );
}

function SourceWords({ s }: { s: CareSource }) {
  if (s.kind === 'web') {
    return (
      <>
        web page, read <span className="mono">{s.readAt}</span>: <ExternalLink url={s.url}>{s.title?.trim() || normalizeWebsite(s.url)}</ExternalLink>
        {s.origin === 'web_search' ? <span className="muted"> (found by a web search{s.verified === false ? '; this link was not among its results, so it backs nothing' : ''})</span> : null}
      </>
    );
  }
  return (
    <>
      told us by phone: {s.who}, <span className="mono">{s.whenIso ?? s.when}</span>
      {s.checkId ? <span className="muted"> (verified by phone)</span> : null}
      {s.communicationId ? (
        <>
          {' '}
          (<Link to="/communications" search={{ id: s.communicationId }}>the call</Link>)
        </>
      ) : null}
    </>
  );
}

export function candidateActions(c: Detail, p: Omit<CandidateDetailProps, 'candidate'>): ActionBarProps {
  if (!p.canWrite) {
    return c.review === 'accepted'
      ? { primary: { label: 'Log a call', onClick: p.onLogCall, shortcut: 'c', disabled: p.busy || !c.personId, title: 'A call or message with them, in Calls and messages' }, secondary: [{ label: 'Add a to-do', onClick: p.onTask, shortcut: 't', disabled: p.busy }] }
      : {};
  }
  const del = { label: 'Delete…', onClick: p.onDelete, shortcut: 'Delete', danger: true, disabled: p.busy, title: 'Hide this candidate (asks first; it is not erased)' };
  const edit = { label: 'Edit', onClick: p.onEdit, shortcut: 'e', disabled: p.busy, title: 'Change the step, name, practice, place, phone, website, licences, access, cost, earliest visit, role or notes' };
  if (c.review === 'proposed') {
    return {
      primary: { label: 'Yes, add to the care team', onClick: p.onAccept, shortcut: 'y', disabled: p.busy, title: 'On your list at Found, and in People and places' },
      secondary: [{ label: 'No', onClick: p.onReject, shortcut: 'x', disabled: p.busy, title: 'Turned down; never suggested again' }, edit],
    };
  }
  if (c.review === 'rejected') return { more: [del] };
  return {
    primary: { label: 'Log a call', onClick: p.onLogCall, shortcut: 'c', disabled: p.busy || !c.personId, title: c.personId ? 'A call or message with them, in Calls and messages' : 'Link them to People and places first (More)' },
    secondary: [
      { label: 'Flare test', onClick: () => p.onFlare(), shortcut: 'f', disabled: p.busy, title: 'Type an answer they gave, with who said it and when' },
      { label: 'Status', onClick: p.onStatus, shortcut: 's', disabled: p.busy, title: 'Found, Contacted, Call booked (with when), Answered the flare test, Shortlisted, Declined, Chosen' },
      { label: 'Add a source', onClick: p.onSource, shortcut: 'b', disabled: p.busy, title: 'A web page or a phone call that says a fact' },
    ],
    more: [
      p.onVerdict ? { label: 'Pass or fail…', onClick: p.onVerdict, shortcut: 'd', disabled: p.busy, title: 'Your verdict on the flare test, with why' } : null,
      { label: 'Add a to-do', onClick: p.onTask, shortcut: 't', disabled: p.busy, title: 'A follow-up, linked to this candidate' },
      edit,
      c.personId ? null : { label: 'Link to People and places', onClick: p.onLinkPerson, disabled: p.busy, title: 'Calls and to-dos reach them through it' },
      'separator',
      del,
    ],
  };
}

function factValue(c: Detail, f: SourcedField): React.ReactNode {
  switch (f) {
    case 'website':
      return c.website ? <ExternalLink url={c.website} /> : null;
    case 'licensedStates':
      return c.licensedStates.length ? c.licensedStates.join(', ') : null;
    case 'accessType':
      return fieldWords('accessType', c.accessType);
    case 'licensedInHomeState':
      return fieldWords('licensedInHomeState', c.licensedInHomeState);
    case 'quotedCost':
      return c.quotedCost ?? null;
    case 'earliestVisit':
      return c.earliestVisit?.value ? <DateText iso={c.earliestVisit.value} precision={c.earliestVisit.precision} text={c.earliestVisit.text} /> : (c.earliestVisit?.text ?? null);
    default:
      return c[f];
  }
}

export function candidateFacts(c: Detail): KeyFact[] {
  const out: KeyFact[] = [
    { label: 'Step', value: stepWords(c.step) },
    { label: 'Role', value: roleWords(c.role) },
  ];
  const show = (f: SourcedField, mono = false, wide = false) => {
    const v = factValue(c, f);
    if (v == null || v === '') return;
    out.push({
      label: FIELD_WORDS[f],
      mono,
      wide,
      value: (
        <span>
          {v} <BackTag b={c.backing[f]} v={c.verification?.[f]} />
        </span>
      ),
    });
  };
  // The name is the title; it gets its own row only to say "not backed yet" or "unverified" (every fact needs a source).
  if (c.backing.name === 'not_backed' || c.verification?.name === 'unverified') show('name');
  show('practice');
  show('city');
  show('state');
  show('phone', true);
  show('website', false, true);
  show('licensedStates');
  show('accessType');
  show('quotedCost');
  show('licensedInHomeState');
  show('earliestVisit');
  if (c.callBookedFor) out.push({ label: 'Call booked for', value: callWords(c.callBookedFor), mono: true, title: c.callBookedFor.text ? `as typed: ${c.callBookedFor.text}` : undefined });
  if (c.personId) {
    out.push({
      label: 'People and places',
      value: (
        <Link to="/people" search={{ id: c.personId }}>
          {c.personName ?? 'Open'}
        </Link>
      ),
    });
  }
  if (c.lastContactAt) out.push({ label: 'Last contact', value: <DateText iso={c.lastContactAt} />, mono: true });
  return out;
}

/** "Verified by phone": a tick with who called and when. Shown when a web search found any fact. */
export function PhoneCheckRow({ c, canWrite, busy, onPhoneCheck, onPhoneUncheck, undone, onUndo }: { c: Detail; canWrite: boolean; busy?: boolean; onPhoneCheck?: () => void; onPhoneUncheck?: () => void; undone?: PhoneCheck[] | null; onUndo?: () => void }) {
  const webFacts = c.webFacts ?? 0;
  const unverified = c.unverified ?? 0;
  const checks = c.phoneChecks ?? [];
  if (!webFacts && !checks.length && !undone?.length) return null;
  const ticked = Boolean(c.verifiedByPhone);
  // Ticked by sources typed one by one (no tick to take back): unticking happens under Sources.
  const canUntick = ticked && checks.length > 0;
  const last = checks[0];
  return (
    <div className="ct-phone-check">
      <label className="ct-check" title={ticked ? (canUntick ? 'Untick: the facts found on the web read Unverified again' : 'Each fact found on the web has its own phone source (see Sources)') : 'Tick once someone has called and checked what the web search found'}>
        <input
          type="checkbox"
          checked={ticked}
          disabled={!canWrite || busy || (ticked && !canUntick)}
          onChange={(e) => (e.target.checked ? onPhoneCheck?.() : onPhoneUncheck?.())}
        />
        Verified by phone
      </label>
      <span className="muted">
        {ticked
          ? last
            ? `${last.who} called, ${last.whenIso ?? last.when}.`
            : 'Every fact found on the web has a phone source.'
          : `${unverified} fact${unverified === 1 ? '' : 's'} found on the web ${unverified === 1 ? 'is' : 'are'} unverified until someone calls and checks.`}
      </span>
      {undone?.length && !ticked && onUndo ? (
        <span>
          <span className="muted">Unticked. </span>
          <Button size="sm" variant="ghost" onClick={onUndo} disabled={busy}>
            Undo
          </Button>
        </span>
      ) : null}
    </div>
  );
}

/** The verdict on the whole flare test, with its hint (request 6). */
export function VerdictBlock({ c, canWrite, busy, onVerdict }: { c: Detail; canWrite: boolean; busy?: boolean; onVerdict?: () => void }) {
  const v = c.flareVerdict ?? null;
  return (
    <div className="ct-verdict">
      <div className="ct-verdict-head">
        <span className="ct-flare-label">Verdict</span>
        {v ? <Tag tone={VERDICT_TONE[v.verdict] ?? 'neutral'}>{FLARE_VERDICT_WORDS[v.verdict].toLowerCase()}</Tag> : <span className="faint">not decided yet</span>}
        {canWrite && onVerdict ? (
          <Button size="sm" variant="ghost" onClick={onVerdict} disabled={busy}>
            {v ? 'Change' : 'Pass or fail'}
          </Button>
        ) : null}
      </div>
      {v?.reason ? <div className="ct-flare-answer">{v.reason}</div> : null}
      {v ? (
        <div className="ct-flare-sources">
          decided by {v.decidedBy ?? 'someone'}
          {v.decidedOn ? (
            <>
              , <span className="mono">{v.decidedOn}</span>
            </>
          ) : null}
        </div>
      ) : null}
      <p className="ct-hint">{FLARE_VERDICT_HINT}</p>
    </div>
  );
}

export function CandidateDetail(props: CandidateDetailProps) {
  const { candidate: c, canWrite } = props;
  const proposal = c.detail.proposal;
  const sources = SOURCED_FIELDS.flatMap((f) => (c.sources[f] ?? []).map((s) => ({ f, s })));
  const history = c.detail.statusHistory ?? [];
  const unverified = c.unverified ?? 0;
  return (
    <DetailPane label="Candidate">
      <DetailHeader
        eyebrow={<span>{c.review === 'proposed' ? 'Waiting for your yes' : c.review === 'rejected' ? 'Turned down' : 'Care team'}</span>}
        title={c.name}
        status={[
          c.review === 'accepted' ? (
            <Tag key="st" tone={STATUS_TONE[c.status]}>
              {statusWords(c.status).toLowerCase()}
            </Tag>
          ) : c.review === 'proposed' ? (
            <Tag key="st" tone="warn">
              found on the web
            </Tag>
          ) : (
            <Tag key="st" tone="ash">
              turned down
            </Tag>
          ),
          c.review === 'accepted' && c.step ? `step ${stepWords(c.step)}` : null,
          c.practice,
          placeWords(c) || null,
          c.review === 'accepted' ? `flare test ${flareWords(c.flareAnswered, c.flareBacked, FLARE_TEST_ITEMS.length)}` : null,
          c.flareVerdict && c.flareVerdict.verdict !== 'not_decided' ? `${FLARE_VERDICT_WORDS[c.flareVerdict.verdict].toLowerCase()}` : null,
          c.notBacked ? `${c.notBacked} not backed yet` : null,
          unverified ? `${unverified} unverified` : null,
        ]}
        actions={candidateActions(c, props)}
        facts={candidateFacts(c)}
      />

      <PhoneCheckRow c={c} canWrite={canWrite && c.review !== 'rejected'} busy={props.busy} onPhoneCheck={props.onPhoneCheck} onPhoneUncheck={props.onPhoneUncheck} undone={props.undone} onUndo={props.onUndo} />

      {proposal ? (
        <Section title="Found on the web" intro="An outside source, not your records. Nothing is added until you say yes.">
          <ul className="ct-lines">
            <li>
              Found <DateTimeText iso={proposal.proposedAt} />
              {proposal.by === 'ask' ? ' by the clinician, in an answer' : ' by Find candidates'}
              {proposal.askMessageId ? (
                <>
                  {' '}
                  (<Link to="/ask">Ask the clinician</Link>)
                </>
              ) : null}
              .
            </li>
            {proposal.why ? <li>Why it may fit: {proposal.why}</li> : null}
            {c.run ? (
              <li>
                Searched for: {c.run.queries.map((q, i) => (
                  <span key={i}>
                    {i ? '; ' : ''}
                    <span className="ct-query">{q}</span>
                  </span>
                ))}
              </li>
            ) : null}
            {proposal.decidedAt ? (
              <li className="muted">
                {c.review === 'rejected' ? 'Turned down' : 'Added'} <DateTimeText iso={proposal.decidedAt} />
                {proposal.decidedBy ? ` by ${proposal.decidedBy}` : ''}.
              </li>
            ) : null}
          </ul>
        </Section>
      ) : null}

      {c.review === 'accepted' ? (
        <Section title="Flare test" count={`${c.flareAnswered} of ${FLARE_TEST_ITEMS.length}`} intro="Typed by you or your chief of staff from what they said. Claude never fills this in.">
          <VerdictBlock c={c} canWrite={canWrite} busy={props.busy} onVerdict={props.onVerdict} />
          <ul className="ct-flare">
            {FLARE_TEST_ITEMS.map((i) => {
              if (i.field === 'licensedInHomeState') {
                // One value with the "Licensed in home state" fact: shown and changed here or with Edit.
                const set = c.licensedInHomeState && c.licensedInHomeState !== 'unknown';
                const old = c.flareTest[i.key]?.answer;
                return (
                  <li key={i.key} className="ct-flare-item">
                    <span className="ct-flare-label">
                      {i.label} <BackTag b={c.backing.licensedInHomeState} v={c.verification?.licensedInHomeState} />
                    </span>
                    {canWrite && props.onHomeState ? (
                      <Button size="sm" variant="ghost" onClick={props.onHomeState} disabled={props.busy}>
                        {set ? 'Change' : 'Answer'}
                      </Button>
                    ) : (
                      <span />
                    )}
                    {set ? <span className="ct-flare-answer">{fieldWords('licensedInHomeState', c.licensedInHomeState)}</span> : <span className="ct-flare-empty">Not asked yet (Unknown).</span>}
                    <span className="ct-flare-sources">The same answer as Licensed in home state above.{old ? ` Typed here before: "${old}"` : ''}</span>
                  </li>
                );
              }
              const a = c.flareTest[i.key];
              const b = flareBacking(a);
              return (
                <li key={i.key} className="ct-flare-item">
                  <span className="ct-flare-label">
                    {i.label} {b === 'not_backed' ? <BackTag b={b} /> : null}
                  </span>
                  {canWrite ? (
                    <Button size="sm" variant="ghost" onClick={() => props.onFlare(i.key)} disabled={props.busy}>
                      {a?.answer ? 'Change' : 'Answer'}
                    </Button>
                  ) : (
                    <span />
                  )}
                  {a?.answer ? <span className="ct-flare-answer">{a.answer}</span> : <span className="ct-flare-empty">Not asked yet.</span>}
                  {a?.answer && a.sources.length ? (
                    <span className="ct-flare-sources">
                      {a.sources.map((s, n) => (
                        <span key={s.id}>
                          {n ? '; ' : ''}
                          <SourceWords s={s} />
                        </span>
                      ))}
                      {a.answeredBy ? ` · typed by ${a.answeredBy}` : ''}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}

      <Section
        title="Sources"
        count={sources.length || undefined}
        intro={
          [
            c.notBacked ? `${c.notBacked} fact${c.notBacked === 1 ? ' is' : 's are'} not backed yet: no source says ${c.notBacked === 1 ? 'it' : 'them'} as ${c.notBacked === 1 ? 'it reads' : 'they read'} now.` : null,
            unverified ? `${unverified} fact${unverified === 1 ? ' is' : 's are'} unverified: only a web search says ${unverified === 1 ? 'it' : 'them'}.` : null,
          ]
            .filter(Boolean)
            .join(' ') || undefined
        }
        actions={
          canWrite && c.review !== 'rejected' ? (
            <Button size="sm" onClick={props.onSource} disabled={props.busy}>
              Add a source
            </Button>
          ) : undefined
        }
      >
        {sources.length ? (
          <ul className="ct-lines">
            {sources.map(({ f, s }) => (
              <li key={`${f}:${s.id}`}>
                <strong>{FIELD_WORDS[f]}</strong> “{f === 'accessType' || f === 'licensedInHomeState' ? fieldWords(f, s.value) : s.value}”: <SourceWords s={s} />
                {canWrite ? (
                  <>
                    {' '}
                    <Button size="sm" variant="ghost" onClick={() => props.onRemoveSource(s.id)} disabled={props.busy} title="Take this source off (a mistake)">
                      Take off
                    </Button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No sources yet.</p>
        )}
      </Section>

      {c.review === 'accepted' ? (
        <Section
          title="Calls and messages"
          count={c.communications.length || undefined}
          actions={
            <Button size="sm" onClick={props.onLogCall} disabled={props.busy || !c.personId}>
              Log a call
            </Button>
          }
        >
          {c.communications.length ? (
            <ul className="ct-lines">
              {c.communications.map((m) => (
                <li key={m.id}>
                  {m.occurredAt ? <DateText iso={m.occurredAt} /> : <span className="faint">no date</span>} · <Link to="/communications" search={{ id: m.id }}>{m.subject}</Link>
                  {m.followUpPromised && !m.followUpDoneAt ? <span className="muted"> · follow-up: {m.followUpPromised}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{c.personId ? 'None logged yet.' : 'Link them to People and places first (More).'}</p>
          )}
        </Section>
      ) : null}

      {c.review === 'accepted' ? (
        <Section
          title="To-dos"
          count={c.tasks.length || undefined}
          actions={
            <Button size="sm" onClick={props.onTask} disabled={props.busy}>
              Add a to-do
            </Button>
          }
        >
          {c.tasks.length ? (
            <ul className="ct-lines">
              {c.tasks.map((t) => (
                <li key={t.id}>
                  {t.status === 'done' || t.status === 'cancelled' ? <Tag tone="ash">{t.status === 'done' ? 'done' : 'cancelled'}</Tag> : t.overdue ? <Tag tone="bad">overdue</Tag> : null} <Link to="/tasks" search={{ id: t.id }}>{t.title}</Link>
                  {t.dueAt ? (
                    <span className="muted">
                      {' '}
                      · due <DateText iso={t.dueAt} />
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">None yet.</p>
          )}
        </Section>
      ) : null}

      {c.notes ? (
        <Section title="Notes">
          <div className="ct-notes">{c.notes}</div>
        </Section>
      ) : null}

      {history.length ? (
        <Section title="Status history" count={history.length}>
          <ul className="ct-lines">
            {history
              .slice()
              .reverse()
              .map((h, i) => (
                <li key={i}>
                  {statusWords(h.to)} · <DateTimeText iso={h.at} />
                  {h.by ? ` · ${h.by}` : ''}
                  {h.bookedFor ? <span className="muted"> · call booked for {h.bookedFor}</span> : null}
                  {h.note ? <span className="muted"> · {h.note}</span> : null}
                </li>
              ))}
          </ul>
        </Section>
      ) : null}
    </DetailPane>
  );
}
