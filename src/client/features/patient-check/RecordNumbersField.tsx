/**
 * Settings, Patient details: "My record numbers" (2026-10-09, the lead's C1). Each hospital or health system gives its
 * own number (MRN), so each number is kept with the place that gave it: a different number from the same place holds
 * a document back; a number from a place not on the list never does on its own.
 */
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import type { RecordNumber } from '@shared/patient-identity';
import './patient-check.css';

export function RecordNumbersField({ value, onChange, readOnly }: { value: RecordNumber[]; onChange: (next: RecordNumber[]) => void; readOnly?: boolean }) {
  const set = (i: number, patch: Partial<RecordNumber>) => onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="record-numbers">
      {value.map((r, i) => (
        <div key={i} className="record-number-row">
          <Input value={r.number} onChange={(e) => set(i, { number: e.target.value })} className="settings-input short mono" placeholder="Number" aria-label="Record number" readOnly={readOnly} />
          <Input value={r.system} onChange={(e) => set(i, { system: e.target.value })} className="settings-input" placeholder="Hospital or health system" aria-label="Where this number is from" readOnly={readOnly} />
          {readOnly ? null : (
            <Button size="sm" variant="ghost" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              Remove
            </Button>
          )}
        </div>
      ))}
      {readOnly ? null : (
        <div>
          <Button size="sm" variant="ghost" onClick={() => onChange([...value, { number: '', system: '' }])} disabled={value.length >= 50}>
            Add a record number
          </Button>
        </div>
      )}
    </div>
  );
}

/** The rows worth saving: a number of at least three characters, trimmed. */
export function cleanNumbers(list: RecordNumber[]): RecordNumber[] {
  return list.map((r) => ({ number: r.number.trim(), system: r.system.trim() })).filter((r) => r.number.length >= 3).slice(0, 50);
}
