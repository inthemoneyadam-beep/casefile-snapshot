import type { InputHTMLAttributes, MouseEvent, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

/** Clicking a label without `htmlFor` focuses the first control of its field, as a real label would. */
function focusControl(e: MouseEvent<HTMLLabelElement>): void {
  const field = e.currentTarget.classList.contains('field-inline-label') ? e.currentTarget.nextElementSibling : e.currentTarget.parentElement;
  const control = field?.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea, [contenteditable="true"]');
  if (control && !control.contains(e.target as Node)) control.focus();
}

/**
 * Label + control + hint/error, stacked. Use inside `.form` grids or standalone. `htmlFor` ties the label to its
 * control's id; without it a click on the label still focuses the field's first control.
 */
export function Field({ label, hint, error, children, inline, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; inline?: boolean; htmlFor?: string }) {
  if (inline) {
    return (
      <>
        <label className="field-inline-label" htmlFor={htmlFor} onClick={htmlFor ? undefined : focusControl}>
          {label}
        </label>
        <div className="field">
          {children}
          {hint ? <span className="hint">{hint}</span> : null}
          {error ? <span className="error">{error}</span> : null}
        </div>
      </>
    );
  }
  return (
    <div className="field">
      <label htmlFor={htmlFor} onClick={htmlFor ? undefined : focusControl}>
        {label}
      </label>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
      {error ? <span className="error">{error}</span> : null}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={3} {...props} />;
}

export function Select({ options, placeholder, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { options: ReadonlyArray<string | { value: string; label: string }>; placeholder?: string }) {
  return (
    <select {...rest}>
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const l = typeof o === 'string' ? o.replace(/_/g, ' ') : o.label;
        return (
          <option key={v} value={v}>
            {l}
          </option>
        );
      })}
    </select>
  );
}
