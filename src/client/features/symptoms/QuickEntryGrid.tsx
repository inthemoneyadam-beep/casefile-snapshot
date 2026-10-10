/**
 * The quick-entry grid: one row per symptom you track, a 0 to 10 scale (0 = none, 10 = the worst), a note.
 * The focused row is state, not DOM focus, so the digit keys work wherever
 * the keyboard is on the page; the wrapper is focusable only so that Tab
 * walks from it into the note inputs and on to the day form.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { DayRow, SymptomDefinition } from '../../api/symptoms';
import { toneClass } from './dates';

const SCALE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export interface QuickEntryGridProps {
  definitions: SymptomDefinition[];
  day: DayRow | undefined;
  focusedId: string | null;
  onFocus: (id: string) => void;
  onScore: (id: string, score: number) => void;
  onNote: (id: string, note: string) => void;
  gridRef: RefObject<HTMLDivElement | null>;
  disabled?: boolean;
  /** Shown instead of the rows when no symptom is tracked yet (the first step, with its button). */
  empty?: ReactNode;
}

function NoteInput({ id, value, hasScore, onSave, onEscape, onFocus }: { id: string; value: string; hasScore: boolean; onSave: (v: string) => void; onEscape: () => void; onFocus: () => void }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  function commit() {
    if (draft.trim() !== value.trim()) onSave(draft);
  }
  return (
    <input
      className="sym-note"
      data-note-for={id}
      value={draft}
      placeholder={hasScore ? 'Add a note' : 'Score it first'}
      disabled={!hasScore}
      title={hasScore ? 'A short note for this symptom today. Enter saves, Esc returns to the grid.' : 'A note needs a score first.'}
      onFocus={() => {
        focused.current = true;
        onFocus();
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
          onEscape();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(value);
          onEscape();
        }
      }}
    />
  );
}

export function QuickEntryGrid({ definitions, day, focusedId, onFocus, onScore, onNote, gridRef, disabled, empty }: QuickEntryGridProps) {
  function backToGrid() {
    gridRef.current?.focus();
  }
  if (!definitions.length && empty) return <>{empty}</>;
  return (
    <div className="sym-grid" ref={gridRef} tabIndex={0} role="grid" aria-label="Score each symptom for the day" aria-rowcount={definitions.length}>
      <div className="sym-row head" role="row">
        <span>Symptom</span>
        <span className="sym-scale-head">Score: 0 = none, 10 = the worst</span>
        <span>Note</span>
      </div>
      {definitions.map((def) => {
        const cur = day?.scores[def.id];
        const focused = def.id === focusedId;
        return (
          <div key={def.id} className={`sym-row${focused ? ' focused' : ''}`} role="row" data-id={def.id} aria-selected={focused} onClick={() => onFocus(def.id)}>
            <span className="sym-name" title={def.description ?? undefined}>
              {def.name}
              {cur?.note ? <span className="sym-has-note"> · has a note</span> : null}
            </span>
            <div className="sym-scale" role="radiogroup" aria-label={`${def.name} score`}>
              {SCALE.map((n) => {
                const on = cur?.score === n;
                return (
                  <button
                    key={n}
                    type="button"
                    tabIndex={-1}
                    role="radio"
                    aria-checked={on}
                    disabled={disabled}
                    className={`sym-cell${on ? ` on ${toneClass(n)}` : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onFocus(def.id);
                      onScore(def.id, n);
                      // A mouse click focuses the cell button, and the page's
                      // digit / = / - / Enter listener ignores keys aimed at a
                      // button; hand the keyboard back to the grid so typing
                      // carries on (and Enter does not re-click this cell).
                      gridRef.current?.focus({ preventScroll: true });
                    }}
                  >
                    {n}
                  </button>
                );
              })}
            </div>
            <NoteInput id={def.id} value={cur?.note ?? ''} hasScore={cur != null} onSave={(v) => onNote(def.id, v)} onEscape={backToGrid} onFocus={() => onFocus(def.id)} />
          </div>
        );
      })}
    </div>
  );
}
