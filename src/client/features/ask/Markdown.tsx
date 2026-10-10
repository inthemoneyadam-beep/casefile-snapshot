/**
 * A small, safe markdown renderer for consult answers: headings, paragraphs,
 * bullet and numbered lists, simple pipe tables, fenced code, block quotes,
 * rules, and inline bold / italic / code. No HTML passes through. Citation
 * markers `[n]` become chips; `[chart:N]` renders the chart in place and any
 * chart without a marker is appended at the end. A chart with no number to
 * draw (a test whose results are all words) is never drawn empty: its values
 * are said as text instead.
 */
import { Fragment, useMemo, type ReactNode } from 'react';
import { LineChart } from '../charts/LineChart';
import { DateText } from '../../ui/DateText';
import { chartWords, hasNumericPoint, WORDS_NOTE } from '../labs/words';
import type { ChartSpec } from '@shared/chart';
import type { AskCitationRef } from '@shared/ask';

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' };

const LIST_RE = /^\s{0,6}(?:[-*+]|\d{1,3}[.)])\s+/;
const ORDERED_RE = /^\s{0,6}\d{1,3}[.)]\s+/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isSeparatorRow(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      blocks.push({ kind: 'p', text: para.join(' ') });
      para = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      blocks.push({ kind: 'code', text: buf.join('\n') });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      blocks.push({ kind: 'h', level: h[1].length, text: h[2].trim() });
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      blocks.push({ kind: 'hr' });
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      flush();
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(splitRow(lines[i++]));
      i--;
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    if (LIST_RE.test(line)) {
      flush();
      const ordered = ORDERED_RE.test(line);
      const items: string[] = [];
      while (i < lines.length && (LIST_RE.test(lines[i]) || (items.length && /^\s{2,}\S/.test(lines[i]) && !LIST_RE.test(lines[i])))) {
        if (LIST_RE.test(lines[i])) items.push(lines[i].replace(LIST_RE, '').trim());
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      i--;
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flush();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      i--;
      blocks.push({ kind: 'quote', text: buf.join(' ') });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

const INLINE_RE = /(\*\*[^*\n]+?\*\*|`[^`\n]+?`|(?<![\w*])\*[^*\n]+?\*(?![\w*])|(?<![\w])_[^_\n]+?_(?![\w])|\[chart:(\d+)\]|\[(\d+)\](?!\()|\[([^\]\n]+?)\]\((\/[^)\s]*)\))/g;

export interface InlineContext {
  citations: Map<number, AskCitationRef>;
  onCitation?: (c: AskCitationRef) => void;
  onLink?: (href: string) => void;
  /** Chart numbers mentioned inline in the current block (rendered after it). */
  chartsHere: number[];
  chartsSeen: Set<number>;
}

/**
 * The chip's hover text. "Found on the page" only means the quoted words were
 * found in the stored page text; it says nothing about whether anyone checked
 * the value, so the words never say verified.
 */
export function citationTitle(c: AskCitationRef): string {
  const where = c.kind === 'communication' ? 'communication' : c.documentTitle ? `${c.documentTitle}${c.pageNumber ? ` p.${c.pageNumber}` : ''}` : c.kind === 'fact' ? 'detail' : 'case summary';
  const state = c.kind === 'page' || (c.kind === 'fact' && c.documentId) ? (c.verified ? 'quote found on the page' : 'quote not found on the page') : c.kind === 'ledger' ? 'case summary line, no source link' : '';
  return `${where}${state ? ` · ${state}` : ''}\n“${c.quote}”`;
}

export function renderInline(text: string, ctx: InlineContext, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  const re = new RegExp(INLINE_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[1];
    const key = `${keyPrefix}-${k++}`;
    if (tok.startsWith('**')) out.push(<strong key={key}>{renderInline(tok.slice(2, -2), ctx, key)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('*') || tok.startsWith('_')) out.push(<em key={key}>{renderInline(tok.slice(1, -1), ctx, key)}</em>);
    else if (m[2] !== undefined) {
      const n = Number(m[2]);
      if (!ctx.chartsHere.includes(n)) ctx.chartsHere.push(n);
      ctx.chartsSeen.add(n);
      out.push(
        <span key={key} className="faint xs mono">
          chart {n}
        </span>,
      );
    } else if (m[3] !== undefined) {
      const n = Number(m[3]);
      const c = ctx.citations.get(n);
      if (!c) out.push(tok);
      else {
        const linkable = c.kind === 'communication' || c.documentId || c.factId;
        out.push(
          <button key={key} type="button" className={`cite${c.verified || c.kind === 'communication' ? '' : ' unverified'}`} title={citationTitle(c)} disabled={!linkable} onClick={() => ctx.onCitation?.(c)}>
            {n}
          </button>,
        );
      }
    } else if (m[4] !== undefined && m[5] !== undefined) {
      const href = m[5];
      out.push(
        <a
          key={key}
          href={href}
          onClick={(e) => {
            if (ctx.onLink) {
              e.preventDefault();
              ctx.onLink(href);
            }
          }}
        >
          {m[4]}
        </a>,
      );
    } else out.push(tok);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export interface MarkdownProps {
  text: string;
  citations?: AskCitationRef[];
  charts?: ChartSpec[];
  onCitation?: (c: AskCitationRef) => void;
  onLink?: (href: string) => void;
  compact?: boolean;
}

function chartSourceWords(spec: ChartSpec): string {
  return spec.source === 'model' ? ' · put together by Claude from the pages it read; check each value against its citation' : ' · built from saved results';
}

/**
 * A chart with no number to draw, said as text: its title, "Results in words; no chart." (or "Nothing to draw; no
 * chart." when it has no value at all), each value with its date, and the chart's own note.
 */
export function ChartInWords({ n, spec }: { n: number; spec: ChartSpec }) {
  const items = chartWords(spec);
  return (
    <div className="ask-chart">
      {spec.title ? <div className="small">{spec.title}</div> : null}
      <div className="faint xs">{items.length ? WORDS_NOTE : 'Nothing to draw; no chart.'}</div>
      {items.length ? (
        <ul>
          {items.map((p, i) => (
            <li key={i}>
              {spec.xType === 'date' ? <DateText iso={p.x} /> : <span className="mono">{p.x}</span>} {p.text}
            </li>
          ))}
        </ul>
      ) : null}
      {spec.note ? <div className="faint xs">{spec.note}</div> : null}
      <div className="faint xs mono">
        chart {n}
        {chartSourceWords(spec)}
      </div>
    </div>
  );
}

export function Markdown({ text, citations = [], charts = [], onCitation, onLink, compact }: MarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const citeMap = useMemo(() => new Map(citations.map((c) => [c.n, c])), [citations]);
  const chartsSeen = new Set<number>();
  const chartHeight = compact ? 200 : 260;
  const chart = (n: number) => {
    const spec = charts[n - 1];
    if (!spec) return null;
    if (!hasNumericPoint(spec)) return <ChartInWords key={`chart-${n}`} n={n} spec={spec} />;
    return (
      <div key={`chart-${n}`} className="ask-chart">
        <LineChart spec={spec} height={chartHeight} onPointClick={(si, pi) => {
          const href = spec.series[si]?.points[pi]?.href;
          if (href && onLink) onLink(href);
        }} />
        <div className="faint xs mono">chart {n}{chartSourceWords(spec)}</div>
      </div>
    );
  };
  const nodes: ReactNode[] = [];
  blocks.forEach((b, i) => {
    const ctx: InlineContext = { citations: citeMap, onCitation, onLink, chartsHere: [], chartsSeen };
    const key = `b${i}`;
    switch (b.kind) {
      case 'h': {
        const level = Math.min(3, b.level);
        const inner = renderInline(b.text, ctx, key);
        nodes.push(level === 1 ? <h1 key={key}>{inner}</h1> : level === 2 ? <h2 key={key}>{inner}</h2> : <h3 key={key}>{inner}</h3>);
        break;
      }
      case 'p': {
        const only = b.text.match(/^\s*\[chart:(\d+)\]\s*$/);
        if (only) {
          chartsSeen.add(Number(only[1]));
          nodes.push(chart(Number(only[1])));
          return;
        }
        nodes.push(
          <div key={key} className="md-p">
            {renderInline(b.text, ctx, key)}
          </div>,
        );
        break;
      }
      case 'list':
        nodes.push(
          b.ordered ? (
            <ol key={key}>
              {b.items.map((it, j) => (
                <li key={j}>{renderInline(it, ctx, `${key}-${j}`)}</li>
              ))}
            </ol>
          ) : (
            <ul key={key}>
              {b.items.map((it, j) => (
                <li key={j}>{renderInline(it, ctx, `${key}-${j}`)}</li>
              ))}
            </ul>
          ),
        );
        break;
      case 'table':
        nodes.push(
          <table key={key} className="md-table">
            <thead>
              <tr>
                {b.header.map((h, j) => (
                  <th key={j}>{renderInline(h, ctx, `${key}-h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {b.header.map((_, ci) => (
                    <td key={ci}>{renderInline(r[ci] ?? '', ctx, `${key}-${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>,
        );
        break;
      case 'code':
        nodes.push(
          <pre key={key} className="md-code">
            {b.text}
          </pre>,
        );
        break;
      case 'quote':
        nodes.push(
          <div key={key} className="md-quote">
            {renderInline(b.text, ctx, key)}
          </div>,
        );
        break;
      case 'hr':
        nodes.push(<hr key={key} />);
        break;
    }
    for (const n of ctx.chartsHere) nodes.push(chart(n));
  });
  charts.forEach((_, i) => {
    if (!chartsSeen.has(i + 1)) nodes.push(chart(i + 1));
  });
  return <Fragment>{nodes}</Fragment>;
}
