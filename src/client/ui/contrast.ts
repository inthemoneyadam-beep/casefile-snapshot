/**
 * Colour contrast, the pure part: parse the theme tokens, put a translucent
 * colour over its surface, and give the WCAG 2.x contrast ratio. No DOM, so
 * the tests can check every text token against every surface it sits on
 * (tests/ui-system-contrast.test.ts) and docs/DESIGN.md can quote the numbers.
 *
 *   contrastRatio('#e4ded3', '#15130f')            // 13.9
 *   themeTokens(css, 'light')['--text-muted']      // '#5a534a'
 *
 * WCAG AA asks 4.5:1 for body text (3:1 for text 18.66px bold / 24px and up);
 * this app holds every text token to 4.5:1 in the dark and light themes.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** '#rgb', '#rrggbb', '#rrggbbaa', 'rgb(...)' or 'rgba(...)' as 0-255 channels and 0-1 alpha; null for anything else. */
export function parseColor(value: string | null | undefined): Rgba | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v);
  if (m) {
    const n = m[1];
    return { r: parseInt(n.slice(0, 2), 16), g: parseInt(n.slice(2, 4), 16), b: parseInt(n.slice(4, 6), 16), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] != null ? Number(m[4]) : 1 };
  return null;
}

/** A translucent colour laid over an opaque one (what the eye sees). */
export function over(top: Rgba, under: Rgba): Rgba {
  const a = top.a;
  return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance (0 black .. 1 white). */
export function luminance(c: Rgba): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** Contrast ratio between a text colour and its background (1 .. 21). A translucent background is laid over `base` first. */
export function contrastRatio(fg: string | Rgba, bg: string | Rgba, base?: string | Rgba): number {
  const f = typeof fg === 'string' ? parseColor(fg) : fg;
  let b = typeof bg === 'string' ? parseColor(bg) : bg;
  if (!f || !b) return NaN;
  if (b.a < 1) {
    const u = base == null ? null : typeof base === 'string' ? parseColor(base) : base;
    if (!u) return NaN;
    b = over(b, u);
  }
  const text = f.a < 1 ? over(f, b) : f;
  const l1 = luminance(text);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Rounded down to two places, so a quoted 4.50 is never really 4.499. */
export function floor2(n: number): number {
  return Math.floor(n * 100) / 100;
}

export type ThemeName = 'dark' | 'dim' | 'light';

/** Every `selector { --token: value; }` block of a stylesheet, comments removed. */
export function tokenBlocks(css: string): Array<{ selector: string; tokens: Record<string, string> }> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Array<{ selector: string; tokens: Record<string, string> }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const tokens: Record<string, string> = {};
    for (const decl of m[2].split(';')) {
      const d = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(decl);
      if (d) tokens[d[1]] = d[2];
    }
    out.push({ selector: m[1].trim().replace(/\s+/g, ' '), tokens });
  }
  return out;
}

/**
 * The tokens one theme ends up with, the way the cascade resolves them:
 * the dark block (`:root`) first, then the theme's own block, then (with
 * `reduced`) its reduced-contrast block. `var(--x)` values are followed.
 */
export function themeTokens(css: string, theme: ThemeName, reduced = false): Record<string, string> {
  const blocks = tokenBlocks(css);
  const merged: Record<string, string> = {};
  const apply = (pred: (sel: string) => boolean) => {
    for (const b of blocks) if (pred(b.selector)) Object.assign(merged, b.tokens);
  };
  const isDarkRoot = (s: string) => s.split(',').some((p) => p.trim() === ':root');
  apply(isDarkRoot);
  if (theme !== 'dark') apply((s) => s.split(',').some((p) => p.trim() === `:root[data-theme='${theme}']`) && !isDarkRoot(s));
  if (reduced) apply((s) => s.includes('[data-reduced]') && s.includes(`[data-theme='${theme}']`));
  const resolve = (v: string, depth = 0): string => {
    const r = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)$/.exec(v.trim());
    if (!r || depth > 8) return v;
    const next = merged[r[1]] ?? r[2];
    return next == null ? v : resolve(next, depth + 1);
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) out[k] = resolve(v);
  return out;
}

/** The text tokens and the surfaces they are checked on (docs/DESIGN.md, Contrast). */
export const TEXT_TOKENS = ['--text', '--text-heading', '--text-muted', '--text-faint', '--accent-strong', '--ok', '--warn', '--bad', '--danger', '--ash', '--info'] as const;
export const SURFACES = ['--bg', '--bg-sunken', '--surface', '--surface-raised', '--surface-hover', '--surface-selected'] as const;

export interface ContrastRow {
  token: string;
  surface: string;
  ratio: number;
}

/** Every text token on every surface of a theme. */
export function contrastTable(tokens: Record<string, string>, texts: readonly string[] = TEXT_TOKENS, surfaces: readonly string[] = SURFACES): ContrastRow[] {
  const rows: ContrastRow[] = [];
  for (const t of texts) {
    for (const s of surfaces) {
      const ratio = contrastRatio(tokens[t], tokens[s], tokens['--bg']);
      rows.push({ token: t, surface: s, ratio: floor2(ratio) });
    }
  }
  return rows;
}

const SURFACE_NAMES: Record<string, string> = { '--bg': 'bg', '--bg-sunken': 'sunken', '--surface': 'surface', '--surface-raised': 'raised', '--surface-hover': 'hover', '--surface-selected': 'selected' };
const TAG_TONES = ['ok', 'warn', 'bad', 'danger', 'ash', 'info', 'accent'] as const;

/**
 * The contrast tables of docs/DESIGN.md (section 5), from a tokens.css text:
 *   npx tsx -e "import('./src/client/ui/contrast.ts').then(m => console.log(m.contrastMarkdown(require('fs').readFileSync('src/client/styles/tokens.css', 'utf8'))))"
 */
export function contrastMarkdown(css: string): string {
  const out: string[] = [];
  const low = (xs: number[]) => Math.min(...xs).toFixed(2);
  for (const theme of ['dark', 'dim', 'light'] as const) {
    const t = themeTokens(css, theme);
    out.push(`#### ${theme[0].toUpperCase()}${theme.slice(1)}`, '');
    out.push(`| Text token | value | ${SURFACES.map((s) => `${SURFACE_NAMES[s]} \`${t[s]}\``).join(' | ')} | lowest |`);
    out.push(`|---|---|${SURFACES.map(() => '---:').join('|')}|---:|`);
    for (const k of TEXT_TOKENS) {
      const r = SURFACES.map((s) => floor2(contrastRatio(t[k], t[s], t['--bg'])));
      out.push(`| \`${k}\` | \`${t[k]}\` | ${r.map((x) => x.toFixed(2)).join(' | ')} | **${low(r)}** |`);
    }
    const tags = TAG_TONES.map((n) => {
      const fg = n === 'accent' ? t['--accent-strong'] : t[`--${n}`];
      return `${n} ${low(['--bg', '--bg-sunken', '--surface', '--surface-raised'].map((s) => floor2(contrastRatio(fg, t[`--${n}-soft`], t[s]))))}`;
    });
    const red = themeTokens(css, theme, true);
    const reduced = ['--text', '--text-heading', '--text-muted', '--text-faint'].map((k) => `${k.slice(2)} ${low(SURFACES.map((s) => floor2(contrastRatio(red[k], red[s], red['--bg']))))}`);
    out.push('', `Tags: ${tags.join(', ')}. Primary button text ${floor2(contrastRatio(t['--text-inverse'], t['--accent'])).toFixed(2)} (hover ${floor2(contrastRatio(t['--text-inverse'], t['--accent-strong'])).toFixed(2)}). Reduced contrast: ${reduced.join(', ')}.`, '');
  }
  return out.join('\n');
}
