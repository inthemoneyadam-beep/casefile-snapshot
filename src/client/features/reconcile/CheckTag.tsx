/**
 * The tag of a detail's automatic check (ui/StatusTag TrustTag), except for a
 * value the app did not compare with the record that is there (another unit,
 * other words, only the month, no sample named, a scan worded differently):
 * that one says "not compared", never "not backed yet", which would promise
 * that adding a record will check it. The tooltip is the reason, as before.
 * The user's own answer on such a value (Not sure, Only in a summary) shows
 * that answer ("unsure", "inferred"), with what the record gives in the tooltip.
 */
import type { TrustInfo } from '@shared/reconcile';
import { Tag, TrustTag, trustTitle } from '../../ui/StatusTag';
import { NOT_COMPARED_TAG, answeredWithRecord, isNotCompared, trustSentence } from './logic';

export function CheckTag({ trust }: { trust: TrustInfo | null | undefined }) {
  if (!trust) return null;
  if (isNotCompared(trust)) {
    return (
      <Tag tone="neutral" title={trust.reason?.trim() ? trustTitle(trust) : NOT_COMPARED_TAG.title}>
        {NOT_COMPARED_TAG.label}
      </Tag>
    );
  }
  if (answeredWithRecord(trust)) {
    const reason = trust.reason ?? '';
    const summary = /^You marked it as seen only in a summary/.test(reason);
    const s = trustSentence(trust);
    return (
      <Tag tone={summary ? 'info' : 'neutral'} title={`${s.label}: ${s.rest}`}>
        {summary ? 'inferred' : /^You were not sure/.test(reason) ? 'unsure' : 'your answer'}
      </Tag>
    );
  }
  return <TrustTag trust={trust} />;
}
