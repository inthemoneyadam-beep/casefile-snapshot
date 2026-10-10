/**
 * One packet already made, in the detail pane's order: what it is, where it stands, the actions (open it, download
 * it, reuse it for a new one; delete under More), the key facts, then what is added at the end and what it holds.
 * Never an internal key: lab tests by their names, timeline kinds and choices in words.
 */
import { DateTimeText } from '../../ui/DateText';
import { DetailHeader, DetailPane, KeyFacts } from '../../ui/DetailPane';
import { Section } from '../../ui/PageHeader';
import { Tag } from '../../ui/StatusTag';
import { ACTIVE_PACKET, packetFileUrl, type PacketDetail as PacketDetailData } from '../../api/export';
import { APPENDED_HOW_WORDS, FACT_SCOPE_WORDS, FINDING_SCOPE_WORDS, browserWords, fmtBytes, packetStatusWords, plural, scopeWords, timelineKindWords } from './words';

export interface PacketDetailProps {
  packet: PacketDetailData;
  busy: boolean;
  onOpen: () => void;
  onTemplate: () => void;
  onDelete: () => void;
  /** Viewers: no delete. */
  readOnly?: boolean;
  /** Lab test names by key (the builder's options), so a chosen test is named, never keyed. */
  testNames?: ReadonlyMap<string, string>;
}

/** Save the file: a link click, so the browser downloads it (the server sends it as an attachment). */
function download(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function testName(key: string, names?: ReadonlyMap<string, string>): string {
  return names?.get(key) ?? key.charAt(0).toUpperCase() + key.slice(1);
}

export function PacketStatusTag({ status }: { status: string }) {
  const w = packetStatusWords(status);
  return <Tag tone={w.tone}>{w.label}</Tag>;
}

export function PacketDetail({ packet, busy, onOpen, onTemplate, onDelete, readOnly = false, testNames }: PacketDetailProps) {
  const c = packet.config;
  const r = packet.result;
  const active = ACTIVE_PACKET.has(packet.status);
  const hasFile = packet.status === 'done' && Boolean(packet.storageKey);
  const job = packet.job;
  const format = packet.format === 'html' ? 'web page' : 'PDF';
  const progress = active
    ? job?.status === 'running'
      ? `${job.progressText ?? 'Being made'}${job.progress > 0 && job.progress < 1 ? ` (${Math.round(job.progress * 100)}%)` : ''}`
      : 'Waiting: packets are made one at a time'
    : null;
  const sections = [c.includeEmergencyCard ? 'Emergency card' : null, c.includeMedications ? 'Medications and allergies' : null, c.includeRecordsIndex ? 'Records checklist' : null, c.includeCareTeam ? 'Care team summary' : null].filter(Boolean) as string[];
  const labs = c.includeLabs ?? [];

  return (
    <DetailPane label="Packet">
      <DetailHeader
        eyebrow={
          <>
            <PacketStatusTag status={packet.status} />
            <span>Packet</span>
          </>
        }
        title={packet.title}
        status={[
          <span key="made">
            Made <DateTimeText iso={packet.createdAt} />
          </span>,
          c.recipient ? <span key="for">for {c.recipient}</span> : null,
          packet.pageCount != null ? <span key="pages">{plural(packet.pageCount, 'page')}</span> : null,
          packet.format ? <span key="format">{format}</span> : null,
        ]}
        actions={{
          primary: { label: `Open the ${format}`, onClick: onOpen, shortcut: 'o', disabled: !hasFile, title: hasFile ? 'Open the packet in a new tab' : 'Ready once the packet is made' },
          secondary: [
            hasFile ? { label: 'Download', onClick: () => download(packetFileUrl(packet.id, true)), title: 'Save the file on this computer' } : null,
            { label: 'Reuse for a new packet', onClick: onTemplate, shortcut: 't', disabled: busy, title: 'Fill the form with this packet’s choices, to change and make again' },
          ],
          more: readOnly ? [] : [{ label: 'Delete…', onClick: onDelete, shortcut: 'Delete', danger: true, disabled: busy || active, title: active ? 'Wait until it is made' : 'Hide it from the list (asks first); the file is kept in the encrypted store' }],
        }}
        facts={[
          { label: 'Documents at the end', value: <span className="mono">{c.documentIds.length}</span> },
          packet.pageCount != null ? { label: 'Pages in all', value: <span className="mono">{packet.pageCount}</span> } : null,
          r && r.htmlPages != null && r.htmlPages !== packet.pageCount ? { label: 'Summary pages', value: <span className="mono">{r.htmlPages}</span> } : null,
          packet.sizeBytes != null ? { label: 'Size', value: <span className="mono">{fmtBytes(packet.sizeBytes)}</span> } : null,
          packet.finishedAt ? { label: 'Finished', value: <DateTimeText iso={packet.finishedAt} /> } : null,
          r ? { label: 'Made with', value: browserWords(r.browser) ?? 'no PDF maker (saved as a web page)' } : null,
          r ? { label: 'Took', value: <span className="mono">{(r.durationMs / 1000).toFixed(1)} s</span> } : null,
        ]}
      />

      {progress ? <div className="notice">{progress}</div> : null}
      {packet.status === 'failed' && packet.error ? (
        <div className="notice bad">
          <strong>It could not be made.</strong> <span className="export-error">{packet.error}</span>
        </div>
      ) : null}
      {packet.note ? <div className="notice warn">{packet.note}</div> : null}

      {r && r.appended.length ? (
        <Section title="Documents added at the end" count={r.appended.length}>
          <div className="table-wrap export-appended-wrap">
            <table className="data-table export-appended">
              <thead>
                <tr>
                  <th title="The label the packet gives the document">Label</th>
                  <th>Document</th>
                  <th className="num">Pages</th>
                  <th className="num" title="The page of the packet it starts on">Starts on page</th>
                  <th>Added as</th>
                </tr>
              </thead>
              <tbody>
                {r.appended.map((a) => (
                  <tr key={a.n}>
                    <td className="mono">D{a.n}</td>
                    <td className="wrap">
                      {a.title}
                      {a.error ? <div className="small muted">{a.error}</div> : null}
                    </td>
                    <td className="num">{a.pages}</td>
                    <td className="num">{a.startPage ?? ''}</td>
                    <td>{a.how === 'failed' ? <Tag tone="bad">could not be added</Tag> : <span className="muted">{APPENDED_HOW_WORDS[a.how] ?? a.how}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      <Section title="What it holds">
        <KeyFacts
          items={[
            { label: 'Details', value: `${scopeWords(c.factIds, FACT_SCOPE_WORDS)}${c.factsFromPacketDocumentsOnly && c.factIds !== 'none' ? ', from the documents at the end only' : ''}`, wide: true },
            { label: 'What Claude noticed', value: scopeWords(c.findingIds, FINDING_SCOPE_WORDS), wide: true },
            {
              label: 'Timeline',
              wide: true,
              value: c.timeline ? (
                <>
                  {c.timeline.from ? <span className="mono">{c.timeline.from}</span> : 'the start'} to {c.timeline.to ? <span className="mono">{c.timeline.to}</span> : 'the end'}
                  {c.timeline.kinds?.length ? `; ${c.timeline.kinds.map(timelineKindWords).join(', ')}` : '; every kind'}
                </>
              ) : (
                'Left out'
              ),
            },
            { label: 'Other pages', value: sections.length ? sections.join(', ') : 'None', wide: true },
            { label: 'Lab charts', value: labs.length ? labs.map((k) => testName(k, testNames)).join(', ') : 'None', wide: true },
            c.purpose ? { label: 'Purpose', value: c.purpose, wide: true } : null,
            c.coverSummary ? { label: 'Cover summary', value: c.coverSummary, wide: true } : null,
          ]}
        />
      </Section>
    </DetailPane>
  );
}
