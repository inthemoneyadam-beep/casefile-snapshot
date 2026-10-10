export type Theme = 'dark' | 'dim' | 'light';

export interface Appearance {
  theme: Theme;
  largeType: boolean;
  reducedContrast: boolean;
  /** Show keyboard shortcut hints on buttons and toolbars (the keys work either way). Off by default. */
  keyHints: boolean;
}

const KEYS = { theme: 'casefile.theme', largeType: 'casefile.largeType', reducedContrast: 'casefile.reducedContrast', keyHints: 'casefile.keyHints' };

export function readAppearance(): Appearance {
  let theme: Theme = 'dark';
  let largeType = false;
  let reducedContrast = false;
  let keyHints = false;
  try {
    const t = localStorage.getItem(KEYS.theme);
    if (t === 'dark' || t === 'dim' || t === 'light') theme = t;
    largeType = localStorage.getItem(KEYS.largeType) === '1';
    reducedContrast = localStorage.getItem(KEYS.reducedContrast) === '1';
    keyHints = localStorage.getItem(KEYS.keyHints) === '1';
  } catch {
    // private mode etc.
  }
  return { theme, largeType, reducedContrast, keyHints };
}

export function applyAppearance(a: Appearance): void {
  const h = document.documentElement;
  h.setAttribute('data-theme', a.theme);
  if (a.largeType) h.setAttribute('data-large', '1');
  else h.removeAttribute('data-large');
  if (a.reducedContrast) h.setAttribute('data-reduced', '1');
  else h.removeAttribute('data-reduced');
  if (a.keyHints) h.setAttribute('data-keyhints', '1');
  else h.removeAttribute('data-keyhints');
  try {
    localStorage.setItem(KEYS.theme, a.theme);
    localStorage.setItem(KEYS.largeType, a.largeType ? '1' : '0');
    localStorage.setItem(KEYS.reducedContrast, a.reducedContrast ? '1' : '0');
    localStorage.setItem(KEYS.keyHints, a.keyHints ? '1' : '0');
  } catch {
    // ignore
  }
  window.dispatchEvent(new CustomEvent('casefile:appearance', { detail: a }));
}

export function cycleTheme(): Theme {
  const a = readAppearance();
  const next: Theme = a.theme === 'dark' ? 'dim' : a.theme === 'dim' ? 'light' : 'dark';
  applyAppearance({ ...a, theme: next });
  return next;
}

export function toggleLargeType(): boolean {
  const a = readAppearance();
  applyAppearance({ ...a, largeType: !a.largeType });
  return !a.largeType;
}

export function toggleReducedContrast(): boolean {
  const a = readAppearance();
  applyAppearance({ ...a, reducedContrast: !a.reducedContrast });
  return !a.reducedContrast;
}
