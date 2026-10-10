/**
 * The page toolbar and its controls: filters and view switches grouped and
 * labelled in plain words, never a row of unlabeled chips.
 *
 *   <Toolbar keys={[['j/k', 'move'], ['enter', 'open'], ['/', 'find']]}>
 *     <Segmented label="View" value={view} onChange={setView} options={[
 *       { value: 'panels', label: 'By test', count: 10 },
 *       { value: 'documents', label: 'By document' },
 *       { value: 'results', label: 'All values', count: 30 },
 *     ]} />
 *     <Segmented label="Sample" value={specimen} onChange={setSpecimen} options={...} />
 *     <SearchField label="Find" placeholder="Test name, e.g. protein" value={q} onChange={setQ} />
 *     <DateRange from={from} to={to} onChange={(d) => setSearch(d)} />
 *   </Toolbar>
 *
 * Toolbar       the band under the page header; `keys` adds the key hints at its right
 * FilterGroup   "Label:" then any control(s) (a select, a checkbox, two inputs)
 * Segmented     one choice out of a few, with its label; arrow keys move and choose
 * SearchField   a search box that says what it searches; / jumps to it
 * DateRange     "Dates: [YYYY-MM] to [YYYY-MM]", committed on Enter or leaving the box
 * KeyHints      the toolbar's key hints (shown only when key hints are on in Settings)
 * ToolbarKeys   the toolbar's right end: Clear filters, the key hints and the always-visible "Keys ?"
 */
import { Children, Fragment, isValidElement, useId, useRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { Kbd } from './Kbd';
import { segmentedKey } from './menuKeys';
import { bindingFor } from '../app/shortcuts';

export type KeyHint = readonly [keys: string, words: ReactNode];

export function Toolbar({ children, keys, label = 'Filters', className }: { children?: ReactNode; keys?: Array<KeyHint | null | false | undefined>; label?: string; className?: string }) {
  const hints = (keys ?? []).filter(Boolean) as KeyHint[];
  // A child marked as the toolbar's end (a component with `toolbarEnd = true`, such as the "Keys ?" group) stays at
  // the top right; the filters wrap beside it, so the end never lands alone on a line of its own.
  const items = Children.toArray(children);
  const endAt = items.findIndex((c) => isValidElement(c) && typeof c.type !== 'string' && (c.type as { toolbarEnd?: boolean }).toolbarEnd === true);
  const end = endAt >= 0 ? items[endAt] : null;
  const main = endAt >= 0 ? items.filter((_, i) => i !== endAt) : items;
  return (
    <div className={['toolbar', end ? 'has-end' : '', className ?? ''].filter(Boolean).join(' ')} role="group" aria-label={label}>
      {end ? <div className="toolbar-main">{main}</div> : main}
      {hints.length ? (
        <>
          <span className="toolbar-spacer" />
          <KeyHints items={hints} />
        </>
      ) : null}
      {end}
    </div>
  );
}

/** Pushes what follows to the right end of the toolbar. */
export function ToolbarSpacer() {
  return <span className="toolbar-spacer" />;
}

/** A visible label ("Sample:") and the control(s) it names. */
export function FilterGroup({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={['filter-group', className ?? ''].filter(Boolean).join(' ')} role="group" aria-labelledby={id}>
      <span className="filter-label" id={id}>
        {label}
      </span>
      {children}
    </div>
  );
}

export interface SegmentOption<V extends string = string> {
  value: V;
  label: ReactNode;
  /** A count after the words (mono), e.g. how many values each view holds. */
  count?: ReactNode;
  /** Hover text: what this choice shows. */
  title?: string;
  disabled?: boolean;
}

export interface SegmentedProps<V extends string = string> {
  /** Visible label before the control ("View"). Leave it out only where the words around it already say it. */
  label?: ReactNode;
  /** Name for screen readers when there is no visible label. */
  ariaLabel?: string;
  value: V;
  options: ReadonlyArray<SegmentOption<V>>;
  onChange: (value: V) => void;
  className?: string;
}

/** One choice out of a few: radio buttons drawn as one joined control. Arrow keys move and choose. */
export function Segmented<V extends string = string>({ label, ariaLabel, value, options, onChange, className }: SegmentedProps<V>) {
  const labelId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = options.findIndex((o) => o.value === value);
  const disabled = options.map((o) => Boolean(o.disabled));
  // Exactly one option takes the Tab stop: the chosen one, else the first that can be chosen.
  const tabStop = index >= 0 ? index : disabled.findIndex((d) => !d);

  function onKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const next = segmentedKey(e.key, index, disabled);
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();
    if (next !== index) onChange(options[next].value);
    refs.current[next]?.focus();
  }

  const control = (
    <div className={['seg', label ? '' : (className ?? '')].filter(Boolean).join(' ')} role="radiogroup" aria-labelledby={label ? labelId : undefined} aria-label={label ? undefined : ariaLabel} onKeyDown={onKey}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === tabStop ? 0 : -1}
          disabled={o.disabled}
          title={o.title}
          className="seg-option"
          onClick={() => o.value !== value && onChange(o.value)}
        >
          {o.label}
          {o.count != null && o.count !== '' ? <span className="seg-count">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
  if (!label) return control;
  return (
    <div className={['filter-group', className ?? ''].filter(Boolean).join(' ')}>
      <span className="filter-label" id={labelId}>
        {label}
      </span>
      {control}
    </div>
  );
}

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type' | 'placeholder'> {
  /** Visible label before the box ("Find"). */
  label?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  /** What it searches, in words: "Test name, e.g. protein". */
  placeholder: string;
  /** Box width in px (default 260). */
  width?: number;
}

/** A search box that says what it searches. `/` anywhere on the page jumps to it (data-filter). */
export function SearchField({ label, value, onChange, placeholder, width, className, ...rest }: SearchFieldProps) {
  const style = width ? ({ '--search-width': `${width}px` } as React.CSSProperties) : undefined;
  return (
    <label className={['search-field', className ?? ''].filter(Boolean).join(' ')} style={style}>
      {label ? <span className="filter-label">{label}</span> : null}
      <input type="search" data-filter="" placeholder={placeholder} aria-label={typeof label === 'string' ? `${label}: ${placeholder}` : placeholder} value={value} onChange={(e) => onChange(e.target.value)} {...rest} />
    </label>
  );
}

export interface DateRangeProps {
  label?: ReactNode;
  from?: string | null;
  to?: string | null;
  /** Called with both ends when either is committed (Enter or leaving the box); an empty box is undefined. */
  onChange: (range: { from?: string; to?: string }) => void;
  /** Placeholder in each box (default YYYY-MM). */
  placeholder?: string;
}

/** "Dates: [from] to [to]": two short boxes taking YYYY, YYYY-MM or YYYY-MM-DD. */
export function DateRange({ label = 'Dates', from, to, onChange, placeholder = 'YYYY-MM' }: DateRangeProps) {
  function commit(which: 'from' | 'to', raw: string) {
    const v = raw.trim() || undefined;
    const current = which === 'from' ? (from ?? undefined) : (to ?? undefined);
    if (v === current) return;
    onChange({ from: which === 'from' ? v : (from ?? undefined), to: which === 'to' ? v : (to ?? undefined) });
  }
  const box = (which: 'from' | 'to', value: string | null | undefined) => (
    <input
      type="text"
      inputMode="numeric"
      key={`${which}-${value ?? ''}`}
      aria-label={which === 'from' ? 'From date' : 'To date'}
      placeholder={placeholder}
      defaultValue={value ?? ''}
      onBlur={(e) => commit(which, e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
  return (
    <FilterGroup label={label}>
      <span className="date-range">
        {box('from', from)}
        <span className="date-range-sep">to</span>
        {box('to', to)}
      </span>
    </FilterGroup>
  );
}

/**
 * The right end of a page toolbar: this page's key hints (shown only when key hints are on in Settings, as
 * everywhere) and one always-visible quiet button, "Keys ?", that opens the keyboard sheet, so the keys can be found
 * without knowing them first. `children` (a "Clear filters" button) sit in the same right-hand group. The Toolbar
 * keeps this group at its top right while the filters wrap beside it (`toolbarEnd`), so "Keys ?" never ends up
 * alone on a line of its own. (Was features/labs/ToolbarKeys.tsx in the pilot; moved here in the 2026-10 rollout.)
 */
export function ToolbarKeys({ items, children }: { items: ReadonlyArray<KeyHint | null | false | undefined>; children?: ReactNode }): ReactNode {
  return (
    <span className="toolbar-end">
      {children}
      <KeyHints items={items} />
      <button type="button" className="btn ghost sm toolbar-keys-button" title="Every key this page answers to (press ? anywhere)" onClick={() => bindingFor('?')?.run(new KeyboardEvent('keydown', { key: '?' }))}>
        Keys <span className="toolbar-keys-cap">?</span>
      </button>
    </span>
  );
}
/** The Toolbar keeps this group at its top right, beside the filters however they wrap. */
ToolbarKeys.toolbarEnd = true;

/** Splits "j/k" into two keys; a lone "/" stays one key. */
export function hintKeys(keys: string): string[] {
  if (keys === '/' || !keys.includes('/')) return [keys];
  const parts = keys.split('/');
  return parts.every((p) => p.length > 0) ? parts : [keys];
}

/** Key hints: [['j/k', 'move'], ['enter', 'open']]. Hidden unless key hints are on in Settings; the keys work either way. */
export function KeyHints({ items }: { items: ReadonlyArray<KeyHint | null | false | undefined> }) {
  const list = items.filter(Boolean) as KeyHint[];
  if (!list.length) return null;
  return (
    <span className="keys" aria-label="Keyboard shortcuts">
      {list.map(([keys, words]) => (
        <span key={keys}>
          {hintKeys(keys).map((k, i) => (
            <Fragment key={i}>
              {i ? '/' : null}
              <Kbd>{k}</Kbd>
            </Fragment>
          ))}{' '}
          {words}
        </span>
      ))}
    </span>
  );
}
