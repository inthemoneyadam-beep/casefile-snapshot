/**
 * The automatic check of one detail, and the user's override.
 *
 * Nothing asks for approval: every detail carries a trust level the app works
 * out by comparing it with the clinical records (src/shared/reconcile.ts).
 * This shows that as one plain sentence ("Verified: from the lab report",
 * "Inaccurate: the lab report says 62 mg/dL on 2024-03-18") and keeps the
 * user's own answers behind a closed "Override": It's accurate, Not sure,
 * It's wrong, Back to automatic, and on a detail that disagrees with a
 * clinical record, The record is wrong (with a reason). Back to automatic
 * shows whenever there is an answer of the user's to forget (trust.byUser, a
 * stored answer, or "not the same event"). "Not the same event" is offered
 * only where the server says it changes something (trust.canSeparate: never
 * on the record's own day), so its message never claims what did not happen.
 * The same rules as the Inaccurate tab (logic.ts overrideOffers and
 * inaccurateActions): a detail outranked by the user's own choice of another
 * record (or their correction) offers "Undo my choice" instead of It's
 * accurate (which the server refuses there); a detail compared with the
 * user's own correction (or the record they chose) offers that Undo instead
 * of The record is wrong; a clinical record restating the report differently
 * does not offer It's accurate (it would only make two records disagree); the
 * user's own correction offers neither It's accurate nor Only in a summary
 * (either would quietly drop it). A value not compared with the record of its
 * day (another unit, other words) says so with what the record says, and
 * links the record.
 * Viewers see the sentence only. Used on a lab value, a scan, a detail and
 * each line of a document summary.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { TrustInfo } from '@shared/reconcile';
import { Button } from '../../ui/Button';
import { useToast } from '../../ui/Toast';
import { errorMessage } from '../../api/client';
import { useMe } from '../../api/users';
import { parseAttributes, useFact, useFactMutations, type FactVerdictStatus, type VerdictBasis } from '../../api/facts';
import { useReconcileMutations } from '../../api/reconcile';
import { ReasonBox } from './ReasonBox';
import { UNDO_WORDS, answeredWithRecord, conflictWithRecord, currentAnswer, isNotCompared, keepWords, notComparedWithRecord, overrideOffers, trustSentence, type OverrideAnswer } from './logic';
import './reconcile.css';

// The rules live in ./logic.ts (no React, so the tests can check them); these names stay importable from here.
export { UNDO_WORDS, isNotCompared, keepWords, notComparedWithRecord, overrideOffers, trustSentence };
export type { OverrideOffers, UndoKind } from './logic';

export interface TrustOverrideProps {
  factId: string | null | undefined;
  trust: TrustInfo | null | undefined;
  /** The detail's stored status and the user's basis (to mark the current answer). */
  status: string | null | undefined;
  basis?: string | null;
  /** A lab result, scan, vital sign, procedure or event: compared with the clinical records. */
  reconciled: boolean;
  /**
   * The source tier of the detail's document (primary, patient, compilation...), null without a document. Left out
   * where the row does not know (a lab value, a scan): the detail is then read once the Override is opened, when it
   * matters (an automatic Inaccurate, where a clinical record restating the report does not offer It's accurate).
   */
  documentTier?: string | null;
  /**
   * Marked "not the same event" (or "both happened") on the Reconciliation page: Back to automatic undoes it.
   * Left out where the row does not know (a lab value, a scan, a summary line): the detail is then read once
   * the Override is opened, unless its trust already says the user answered (trust.byUser).
   */
  separated?: boolean;
  /** Offer "Only in a summary" as well (the Details page, where the f key does the same). */
  withSummary?: boolean;
  /** Dense form for one line of a document summary: no disclosure, the answers shown at once. */
  compact?: boolean;
  /** Called after an answer is saved. */
  onDone?: () => void;
}

/**
 * The trust sentence and the Override. Renders nothing for a detail without
 * a trust (a value typed by hand).
 */
export function TrustOverride({ factId, trust, status, basis, reconciled, documentTier, separated, withSummary = false, compact = false, onDone }: TrustOverrideProps) {
  const canWrite = useMe().canWrite;
  const facts = useFactMutations();
  const rc = useReconcileMutations();
  const qc = useQueryClient();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  // The compact form shows its answers at once; the other opens them under "Override".
  const [open, setOpen] = useState(compact);
  const current = currentAnswer(status, basis);
  const reading = open && reconciled && canWrite && Boolean(factId) && Boolean(trust) && !trust?.byUser && trust?.trust !== 'replaced';
  // Is it marked "not the same event"? Only asked when nothing else already offers Back to automatic, and only once the answers are open.
  const lookUpSeparated = reading && separated === undefined && current === null;
  // Its document's tier, where the caller does not know it and an automatic Inaccurate makes it matter.
  const lookUpTier = reading && documentTier === undefined && trust?.trust === 'inaccurate';
  const detail = useFact(lookUpSeparated || lookUpTier ? factId : null);
  const isSeparated = separated ?? (detail.data ? parseAttributes(detail.data)._reconcileSeparate === true : false);
  // Unknown (undefined) only while it is being read; a failed read falls back to offering It's accurate, whose
  // toast then says plainly what it did (keepWords).
  const tier = documentTier !== undefined ? documentTier : detail.data ? ((detail.data.document as { sourceTier?: string | null } | null)?.sourceTier ?? null) : detail.isError ? null : undefined;
  if (!trust) return null;
  const s = trustSentence(trust);
  const busy = facts.verdict.isPending || rc.busy;
  // A detail replaced by a newer reading or a merge by hand is changed where that was decided.
  const canOverride = canWrite && Boolean(factId) && trust.trust !== 'replaced';
  const recordIsOther = Boolean(trust.recordFactId && trust.recordFactId !== factId);
  const offers = overrideOffers({ factId, trust, status, basis, reconciled, separated: isSeparated, documentTier: tier });

  const done = (msg: string) => {
    toast(msg, 'ok');
    setAsking(false);
    onDone?.();
    void qc.invalidateQueries();
  };
  const fail = (err: unknown) => toast(errorMessage(err, 'That did not work'), 'bad');
  const verdict = (st: FactVerdictStatus, b: VerdictBasis | null, msg: string) => facts.verdict.mutate({ id: factId!, status: st, basis: b }, { onSuccess: () => done(msg), onError: fail });

  function answer(a: OverrideAnswer | 'automatic') {
    if (!factId) return;
    if (a === 'accurate') {
      if (reconciled) rc.keep.mutate(factId, { onSuccess: (res) => done(keepWords(res?.trust)), onError: fail });
      else verdict('confirmed', 'original', 'Marked accurate');
    } else if (a === 'summary') verdict('confirmed', 'summary', 'Marked as seen only in a summary; the original is on your Records checklist to request');
    else if (a === 'unsure') verdict('unverified', 'unsure', 'Marked not sure');
    else if (a === 'wrong') verdict('disputed', null, 'Marked wrong. It stays on file, set aside.');
    else if (reconciled) rc.reset.mutate(factId, { onSuccess: () => done('Back to automatic'), onError: fail });
    else verdict('unverified', null, 'Back to automatic');
  }

  const recordLink =
    // Also on a value not compared with the record of its day (or a disagreement that record could not settle, or the
    // user's own answer on such a value): the user can look at the record themselves.
    trust.recordDocumentId && ((recordIsOther && (trust.trust === 'accurate' || trust.trust === 'inaccurate')) || isNotCompared(trust) || conflictWithRecord(trust) || answeredWithRecord(trust)) ? (
      <>
        {' '}
        <Link to="/documents/$id" params={{ id: trust.recordDocumentId }} className="xs" title={`Open ${trust.recordDocumentTitle ?? 'the record'}`}>
          open the record
        </Link>
      </>
    ) : null;
  const sentence = (
    <div className={`trust-line ${trust.trust}`}>
      <strong>{s.label}:</strong> {s.rest}
      {trust.trust === 'conflict' ? (
        <>
          {' '}
          <Link to="/reconcile" search={{ tab: 'needs', id: trust.eventKey ?? undefined }}>
            See Reconciliation.
          </Link>
        </>
      ) : null}
      {recordLink}
    </div>
  );
  if (!canOverride) return <div className="trust-box">{sentence}</div>;

  const undo = offers.undo ? UNDO_WORDS[offers.undo] : null;
  const buttons = (
    <>
      <div className="trust-override-buttons" role="group" aria-label="Your answer">
        {offers.accurate ? (
          <Button
            size="sm"
            className={current === 'accurate' ? 'current' : undefined}
            aria-pressed={current === 'accurate'}
            disabled={busy || offers.accurateWaiting}
            onClick={() => answer('accurate')}
            title="You checked it against the original and it is right: it is kept as accurate whatever the other documents say."
          >
            It's accurate
          </Button>
        ) : null}
        {withSummary && offers.summary ? (
          <Button size="sm" className={current === 'summary' ? 'current' : undefined} aria-pressed={current === 'summary'} disabled={busy} onClick={() => answer('summary')} title="You have only seen it in a summary; the original goes on your Records checklist to request.">
            Only in a summary
          </Button>
        ) : null}
        <Button size="sm" className={current === 'unsure' ? 'current' : undefined} aria-pressed={current === 'unsure'} disabled={busy} onClick={() => answer('unsure')} title="You looked and cannot tell.">
          Not sure
        </Button>
        <Button size="sm" className={current === 'wrong' ? 'current' : undefined} aria-pressed={current === 'wrong'} disabled={busy} onClick={() => answer('wrong')} title="It stays on file but is set aside; the clinician will not rely on it.">
          It's wrong
        </Button>
        {offers.separate && factId ? (
          <Button size="sm" disabled={busy} onClick={() => rc.separate.mutate(factId, { onSuccess: () => done('Marked as another occasion. It is compared on its own date only from now on.'), onError: fail })} title="It is about another occasion (another test, another day): compare it on its own date only.">
            Not the same event
          </Button>
        ) : null}
        {offers.recordWrong ? (
          <Button size="sm" variant="ghost" aria-expanded={asking} disabled={busy} onClick={() => setAsking((v) => !v)} title="Your own word corrects a clinical mistake: this detail becomes what is used, and the record is shown as wrong here (never changed).">
            The record is wrong
          </Button>
        ) : null}
        {undo && trust.recordFactId ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => rc.reset.mutate(trust.recordFactId!, { onSuccess: () => done(undo.done), onError: fail })} title={undo.title}>
            {undo.label}
          </Button>
        ) : null}
        {offers.reset ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => answer('automatic')} title="Forget your answer here and let the app compare it with the records again.">
            Back to automatic
          </Button>
        ) : null}
      </div>
      {asking && factId ? (
        <ReasonBox
          title="The record is wrong"
          busy={rc.correct.isPending}
          onCancel={() => setAsking(false)}
          onSave={(reason) => rc.correct.mutate({ factId, reason }, { onSuccess: () => done('Saved. Your correction is used for this event; the record is kept as written.'), onError: fail })}
        />
      ) : null}
    </>
  );

  if (compact) {
    return (
      <div className="trust-box">
        {sentence}
        {buttons}
      </div>
    );
  }
  return (
    <div className="trust-box">
      {sentence}
      <details className="trust-override" onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>Your answer</summary>
        <div className="trust-override-body">
          <span className="trust-override-hint">Only needed when you know better than the automatic check. Your answer outranks it.</span>
          {buttons}
        </div>
      </details>
    </div>
  );
}
