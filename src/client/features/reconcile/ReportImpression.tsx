/**
 * Scan wording is never judged automatically (services/reconcile.ts): where
 * the scan report of the same scan is here and the two impressions are not
 * word for word the same, the scan is "not compared" and the report's whole
 * impression is shown under this one, to read side by side (the reason above
 * quotes it clipped). Read from the report's own detail; the words the reason
 * quotes while that loads or if it cannot be read. Used on a scan's page and
 * on a scan's detail (Details from documents); only for scans.
 */
import { Link } from '@tanstack/react-router';
import type { TrustInfo } from '@shared/reconcile';
import { parseAttributes, useFact } from '../../api/facts';
import { impressionOf, notComparedWithRecord, quotedRecordWords } from './logic';
import './reconcile.css';

export function ReportImpression({ factId, trust }: { factId: string | null | undefined; trust: TrustInfo | null | undefined }) {
  const recordId = trust && notComparedWithRecord(trust) && trust.recordFactId && trust.recordFactId !== factId ? trust.recordFactId : null;
  const rec = useFact(recordId);
  if (!recordId || !trust) return null;
  const full = rec.data ? impressionOf(parseAttributes(rec.data)) : null;
  const words = full ?? quotedRecordWords(trust);
  const cite = rec.data?.citations?.[0];
  const title = trust.recordDocumentTitle?.trim() || 'The scan report';
  return (
    <div className="rc-report-words">
      <div className="small muted">
        {trust.recordDocumentId ? (
          <Link to="/documents/$id" params={{ id: trust.recordDocumentId }} search={{ page: cite?.pageNumber ?? undefined, cite: cite?.id ?? undefined }} title="Open the scan report">
            {title}
          </Link>
        ) : (
          title
        )}
        {/report/i.test(title) ? ' says:' : ' (the scan report) says:'}
      </div>
      {words ? (
        <p className="rc-report-impression">
          {words}
          {!full && rec.isPending ? <span className="faint xs"> (the start; reading the rest…)</span> : null}
        </p>
      ) : (
        <span className="muted small">{rec.isPending ? 'Reading the report…' : 'Open the report to read its impression.'}</span>
      )}
      <span className="faint xs">Scan wording is not compared automatically: read the two side by side.</span>
    </div>
  );
}
