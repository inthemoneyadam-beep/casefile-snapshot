/**
 * Find candidates on the web (off until you use it). You type what to look for: the condition or need, the kind of
 * clinician or service, the role, a place, the state they must be licensed in. The app turns that into a few searches
 * you can change. "Check" shows every search as it will be sent (or refused, with why: never your name, date of birth,
 * record numbers or words from your records) and the cost; only then can it be sent. What comes back waits for your yes.
 */
import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Field, Input, Select, Textarea } from '../../ui/Field';
import { Tag } from '../../ui/StatusTag';
import { Kbd } from '../../ui/Kbd';
import { CARE_ROLES, CARE_ROLE_WORDS, queryReasonWords, suggestQueries, usdWords, type CareRole, type FindCriteria } from '@shared/care-team';
import type { FindBody, FindCheck } from '../../api/care-team';
import { ScopeSwitch } from './WebSearchSettings';

const EMPTY: FindCriteria = { condition: '', kind: '', role: null, place: '', licensedIn: '' };

export function FindDialog({
  open,
  onClose,
  cap,
  checking,
  sending,
  error,
  onCheck,
  onSend,
}: {
  open: boolean;
  onClose: () => void;
  /** Settings: the most searches one run may make. */
  cap: number;
  checking: boolean;
  sending: boolean;
  error: string | null;
  onCheck: (body: FindBody) => Promise<FindCheck>;
  onSend: (body: FindBody) => void;
}) {
  const [c, setC] = useState<FindCriteria>(EMPTY);
  const [queries, setQueries] = useState('');
  const [edited, setEdited] = useState(false);
  const [max, setMax] = useState(String(cap));
  const [check, setCheck] = useState<{ key: string; result: FindCheck } | null>(null);
  useEffect(() => {
    if (!open) return;
    setC(EMPTY);
    setQueries('');
    setEdited(false);
    setMax(String(cap));
    setCheck(null);
  }, [open, cap]);
  // The suggested searches follow the boxes until you change them yourself.
  useEffect(() => {
    if (!edited) setQueries(suggestQueries(c).join('\n'));
  }, [c, edited]);
  const body = useMemo<FindBody>(() => {
    const n = Math.round(Number(max));
    return { criteria: c, queries: queries.split('\n').map((q) => q.trim()).filter(Boolean), maxSearches: Number.isFinite(n) && n >= 1 ? Math.min(n, cap) : cap };
  }, [c, queries, max, cap]);
  const key = JSON.stringify(body);
  const current = check && check.key === key ? check.result : null;
  const set = (k: keyof FindCriteria) => (e: { target: { value: string } }) => setC((s) => ({ ...s, [k]: k === 'role' ? (e.target.value || null) : e.target.value }));

  async function runCheck() {
    if (!body.queries.length || checking) return;
    try {
      const result = await onCheck(body);
      setCheck({ key, result });
    } catch {
      setCheck(null);
    }
  }
  function send() {
    if (!current?.ok || sending) return;
    onSend(body);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Find candidates on the web"
      width={720}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button onClick={() => void runCheck()} disabled={!body.queries.length || checking} title="Shows each search as it will be sent, and the cost. Nothing is sent.">
            {checking ? 'Checking…' : 'Check'}
          </Button>
          <Button variant="primary" onClick={send} disabled={!current?.ok || sending} title={current ? current.words : 'Check first'}>
            {sending ? 'Sending…' : 'Search the web'} <Kbd>ctrl+enter</Kbd>
          </Button>
        </>
      }
    >
      <div
        className="stack"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            if (current?.ok) send();
            else void runCheck();
          }
        }}
      >
        {error ? <div className="notice bad small">{error}</div> : null}
        <p className="muted small">Only what you type here is sent: condition words, the kind of clinician, places. Never your name, date of birth, record numbers or anything from your records. Results wait for your yes.</p>
        <ScopeSwitch />
        <div className="ct-form">
          <Field label="Condition or need" hint="e.g. type 2 diabetes, insulin pump training">
            <Input autoFocus data-autofocus="" value={c.condition} onChange={set('condition')} />
          </Field>
          <Field label="Kind of clinician or service" hint="e.g. rheumatologist, home infusion">
            <Input value={c.kind} onChange={set('kind')} />
          </Field>
          <Field label="Role">
            <Select aria-label="Role" value={c.role ?? ''} placeholder="Any role" options={CARE_ROLES.map((r) => ({ value: r, label: CARE_ROLE_WORDS[r as CareRole] }))} onChange={set('role')} />
          </Field>
          <Field label="Where" hint="e.g. Columbus, Ohio">
            <Input value={c.place} onChange={set('place')} />
          </Field>
          <Field label="Licensed in" hint="e.g. Ohio">
            <Input value={c.licensedIn} onChange={set('licensedIn')} />
          </Field>
          <Field label="Most searches" hint={`Up to ${cap} (Settings).`}>
            <Input type="text" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} />
          </Field>
          <div className="full">
            <Field label="Searches, one per line" hint="Made from the boxes above. Change them if you like.">
              <Textarea
                rows={4}
                value={queries}
                onChange={(e) => {
                  setEdited(true);
                  setQueries(e.target.value);
                }}
              />
            </Field>
          </div>
        </div>
        {current ? (
          <div className="stack tight">
            <ul className="ct-checks" aria-label="How each search will go">
              {current.queries.map((q, i) => (
                <li key={i}>
                  {q.ok ? <Tag tone="ok">will be sent</Tag> : <Tag tone="bad">refused</Tag>}
                  <span className="ct-query">{q.query}</span>
                  {!q.ok ? <span className="why">{queryReasonWords(q.reasons)} Never sent.</span> : null}
                </li>
              ))}
            </ul>
            {current.criteria.length ? <div className="notice bad small">{current.words}</div> : <p className="small">{current.words}</p>}
            <p className="muted small">
              Cost: {usdWords(current.estimate.usd)} at most ({current.maxSearches} searches at 1 cent each, and reading the results). The real cost goes in the AI usage log.
              {current.scopeWords ? ` ${current.scopeWords}.` : ''}
            </p>
            {current.domainsLeftOut?.length ? <div className="notice warn small">{current.domainsLeftOut.length} site{current.domainsLeftOut.length === 1 ? ' is' : 's are'} left out: the web search takes at most 64. Left out: {current.domainsLeftOut.join(', ')}.</div> : null}
          </div>
        ) : check ? (
          <p className="muted small">Changed since the check. Check again.</p>
        ) : null}
      </div>
    </Dialog>
  );
}
