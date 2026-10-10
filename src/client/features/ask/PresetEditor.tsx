/**
 * Answer settings: the steps of Depth, left to right. Each step has a name,
 * the Claude model it uses, how hard it thinks, what of the case it reads and
 * the most it may read at once. Saves to settings `ask.presets` (and the step
 * new questions start on, `ask.defaultPreset`). The stored codes (effort
 * "xhigh", context "ledger") are shown as words.
 */
import { useEffect, useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Input, Select } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { useUpdateSettings } from '../../api/hooks';
import { ApiError } from '../../api/client';
import { DEFAULT_CONSULT_PRESETS, MODEL_CHOICES, MODEL_LABELS, type ConsultPreset } from '@shared/constants';
import { CONTEXT_WORDS, EFFORT_WORDS } from './words';

export function PresetEditor({ open, onClose, presets, defaultKey }: { open: boolean; onClose: () => void; presets: ConsultPreset[]; defaultKey: string }) {
  const [rows, setRows] = useState<ConsultPreset[]>(presets);
  const [def, setDef] = useState(defaultKey);
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateSettings();
  const toast = useToast();
  useEffect(() => {
    if (open) {
      setRows(presets.map((p) => ({ ...p })));
      setDef(defaultKey);
      setError(null);
    }
  }, [open, presets, defaultKey]);

  const set = (i: number, patch: Partial<ConsultPreset>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = () => {
    for (const r of rows) {
      if (!r.label.trim()) return setError('Every step needs a name.');
      if (!Number.isFinite(r.maxContextTokens) || r.maxContextTokens < 10_000) return setError('"Reads at most" must be at least 10,000 tokens.');
    }
    const cleaned = rows.map((r) => ({ ...r, label: r.label.trim(), hint: r.hint ?? '', maxContextTokens: Math.round(r.maxContextTokens) }));
    update.mutate(
      { 'ask.presets': cleaned, 'ask.defaultPreset': rows.some((r) => r.key === def) ? def : cleaned[0].key },
      {
        onSuccess: () => {
          toast('Answer settings saved', 'ok');
          onClose();
        },
        onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
      },
    );
  };

  if (!open) return null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Answer settings"
      width={720}
      footer={
        <>
          <Button variant="ghost" onClick={() => setRows(DEFAULT_CONSULT_PRESETS.map((p) => ({ ...p })))} title="Put every step back as CaseFile set it">
            Reset to the defaults
          </Button>
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={update.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        {error ? <div className="notice bad small">{error}</div> : null}
        <p className="preset-intro">
          Each step of Depth, from the quickest (left on the slider) to the deepest (right). A deeper step thinks harder and reads more of the case: it takes longer and costs more. “New questions start here” marks the step the slider starts on.
        </p>
        <ol className="preset-steps">
          {rows.map((r, i) => (
            <li key={r.key} className="preset-step">
              <div className="preset-step-head">
                <span className="preset-step-n mono">{i + 1}</span>
                <label className="preset-field">
                  <span>Name</span>
                  <Input value={r.label} onChange={(e) => set(i, { label: e.target.value })} style={{ width: 160 }} />
                </label>
                <label className="preset-start">
                  <input type="radio" name="default-preset" checked={def === r.key} onChange={() => setDef(r.key)} />
                  New questions start here
                </label>
              </div>
              <div className="preset-fields">
                <label className="preset-field">
                  <span>Model</span>
                  <Select value={r.model} options={[...new Set([...MODEL_CHOICES, r.model])].map((m) => ({ value: m, label: MODEL_LABELS[m] ?? m }))} onChange={(e) => set(i, { model: e.target.value })} style={{ width: 250 }} />
                </label>
                <label className="preset-field">
                  <span>How hard it thinks</span>
                  <Select value={r.effort} options={(Object.keys(EFFORT_WORDS) as ConsultPreset['effort'][]).map((e) => ({ value: e, label: EFFORT_WORDS[e] }))} onChange={(e) => set(i, { effort: e.target.value as ConsultPreset['effort'] })} style={{ width: 160 }} />
                </label>
                <label className="preset-field">
                  <span>What it reads</span>
                  <Select value={r.contextMode} options={(Object.keys(CONTEXT_WORDS) as ConsultPreset['contextMode'][]).map((c) => ({ value: c, label: CONTEXT_WORDS[c] }))} onChange={(e) => set(i, { contextMode: e.target.value as ConsultPreset['contextMode'] })} style={{ width: 300 }} />
                </label>
                <label className="preset-field">
                  <span>Reads at most (tokens)</span>
                  <Input type="number" min={10_000} step={10_000} value={r.maxContextTokens} onChange={(e) => set(i, { maxContextTokens: Number(e.target.value) })} style={{ width: 120 }} className="mono" />
                </label>
                <label className="preset-field wide">
                  <span>Description (shown on hover)</span>
                  <Input value={r.hint} onChange={(e) => set(i, { hint: e.target.value })} />
                </label>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Dialog>
  );
}
