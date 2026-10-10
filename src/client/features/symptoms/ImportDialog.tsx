/**
 * CSV import: pick a file or paste text. Import first asks the server for a
 * dry run. When the file would replace values already in the log, those are
 * listed (date, field, the value now, the value from the file) and a second,
 * explicit "Overwrite" click is needed before anything is written; symptom
 * scores and the daily log keep no history, so this is the only chance to
 * see what an older export would undo. Otherwise the import runs at once.
 * The result lists the rows skipped with the reason and every value that
 * was replaced, so nothing fails or changes quietly.
 */
import { useEffect, useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Kbd } from '../../ui/Kbd';
import { Tag } from '../../ui/StatusTag';
import type { ImportOverwrite, ImportResult } from '../../api/symptoms';
import { plural } from '../../app/text';

export interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  /** Runs the import; with dryRun the server writes nothing and reports what would change. */
  run: (csv: string, dryRun: boolean) => Promise<ImportResult>;
  /** Called after a real import has been written. */
  onImported: (r: ImportResult) => void;
}

function cell(v: string | number): string {
  return typeof v === 'number' ? String(v) : v;
}

function OverwriteTable({ items }: { items: ImportOverwrite[] }) {
  return (
    <div className="sym-import-diff">
      <table>
        <thead>
          <tr>
            <th style={{ width: 100 }}>Date</th>
            <th style={{ width: 140 }}>Field</th>
            <th>In the log now</th>
            <th>From the file</th>
          </tr>
        </thead>
        <tbody>
          {items.map((o, i) => (
            <tr key={`${o.date}-${o.field}-${i}`}>
              <td className="mono">{o.date}</td>
              <td className="small">{o.field}</td>
              <td className="wrap small">{cell(o.from)}</td>
              <td className="wrap small">{cell(o.to)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ColumnLine({ columns }: { columns: Record<string, string> }) {
  const entries = Object.entries(columns);
  if (!entries.length) return null;
  return (
    <div className="faint xs">
      Columns read as:{' '}
      {entries.map(([h, as], i) => (
        <span key={h}>
          {i ? ', ' : ''}
          <span className="mono">{h}</span> ({as === 'ignored' ? 'ignored, a second column for the same field' : as})
        </span>
      ))}
    </div>
  );
}

function SkippedTable({ skipped }: { skipped: ImportResult['skipped'] }) {
  if (!skipped.length) return null;
  return (
    <table>
      <thead>
        <tr>
          <th style={{ width: 60 }}>Row</th>
          <th>Reason skipped</th>
        </tr>
      </thead>
      <tbody>
        {skipped.map((s) => (
          <tr key={s.row}>
            <td className="num">{s.row}</td>
            <td className="wrap small">{s.reason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ImportDialog({ open, onClose, run, onImported }: ImportDialogProps) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  /** The dry run for `text`, kept while it lists values the import would overwrite. */
  const [preview, setPreview] = useState<{ text: string; result: ImportResult } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setText('');
      setFileName(null);
      setPreview(null);
      setResult(null);
      setError(null);
    }
  }, [open]);

  const pending = preview && preview.text === text ? preview.result : null;

  async function pick(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setResult(null);
    setText(await file.text());
  }

  async function go() {
    if (busy || !text.trim() || result) return;
    setBusy(true);
    setError(null);
    try {
      // A confirmed preview goes straight to the write; anything else is
      // previewed first and stops there when it would replace existing values.
      if (!pending) {
        const dry = await run(text, true);
        if (dry.overwritten.length) {
          setPreview({ text, result: dry });
          return;
        }
      }
      const r = await run(text, false);
      setPreview(null);
      setResult(r);
      onImported(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const n = pending?.overwritten.length ?? 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Import symptom diary from a spreadsheet (CSV)"
      width={720}
      footer={
        <>
          <Button onClick={onClose}>{result ? 'Close' : 'Cancel'}</Button>
          {result ? null : n ? (
            <Button variant="danger" disabled={busy} onClick={() => void go()}>
              Overwrite {plural(n, 'existing value')} <Kbd>ctrl+enter</Kbd>
            </Button>
          ) : (
            <Button variant="primary" disabled={busy || !text.trim()} onClick={() => void go()}>
              {busy ? 'Importing…' : 'Import'} <Kbd>ctrl+enter</Kbd>
            </Button>
          )}
        </>
      }
    >
      <div
        className="stack"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            void go();
          }
        }}
      >
        <div className="muted small">
          One row per day. Columns: <span className="mono">date</span> (required), one column per symptom name (0–10), and optionally <span className="mono">sleep_hours</span>, <span className="mono">sleep_quality</span>, <span className="mono">energy</span>,{' '}
          <span className="mono">notes</span>, <span className="mono">tags</span>. Unknown symptom columns become definitions. A row with a bad or future date or a bad value is skipped whole and listed below. A value already in the log for that date is replaced by the file&apos;s value
          (an empty cell leaves it alone); before anything is written you see every value that would change and confirm it. Re-importing the same file changes nothing.
        </div>
        <div className="row wrap">
          <label className="btn sm">
            Choose file
            <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={(e) => void pick(e.target.files?.[0])} />
          </label>
          <span className="faint xs">{fileName ?? 'or paste below'}</span>
        </div>
        <textarea
          rows={8}
          className="mono"
          value={text}
          placeholder={'date,Dizziness,Joint pain,sleep_hours,notes\n2024-06-10,6,3,6.5,Rough day'}
          onChange={(e) => {
            setText(e.target.value);
            setResult(null);
          }}
        />
        {error ? <div className="notice bad small">{error}</div> : null}
        {pending && !result ? (
          <div className="stack tight">
            <div className="notice warn small">
              Nothing has been written yet. This file replaces {plural(n, 'value')} already in the log (listed below; there is no undo). It would write {plural(pending.imported, 'day')} and {plural(pending.entries, 'score')}
              {pending.created.length ? `, and add ${pending.created.join(', ')}` : ''}
              {pending.skipped.length ? `; ${plural(pending.skipped.length, 'row')} would be skipped` : ''}. Click Overwrite to go ahead, or Cancel.
            </div>
            <OverwriteTable items={pending.overwritten} />
            <ColumnLine columns={pending.columns} />
            <SkippedTable skipped={pending.skipped} />
          </div>
        ) : null}
        {result ? (
          <div className="stack tight">
            <div className="row wrap small">
              <Tag tone="ok">{plural(result.imported, 'day')} written</Tag>
              <span className="mono muted">{plural(result.entries, 'score')}</span>
              {result.created.length ? <span className="muted">created: {result.created.join(', ')}</span> : null}
              {result.overwritten.length ? <Tag tone="warn">{plural(result.overwritten.length, 'value')} replaced</Tag> : null}
              {result.skipped.length ? <Tag tone="warn">{result.skipped.length} skipped</Tag> : null}
            </div>
            <ColumnLine columns={result.columns} />
            {result.overwritten.length ? (
              <>
                <div className="faint xs">Replaced values (the log keeps no history; this list is the record of what changed):</div>
                <OverwriteTable items={result.overwritten} />
              </>
            ) : null}
            <SkippedTable skipped={result.skipped} />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
