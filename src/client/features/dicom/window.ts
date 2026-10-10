/**
 * The viewer's window (brightness and contrast) in plain words: which preset is
 * on screen, for the toolbar's "Window:" control, and where the window on screen
 * came from, for the status line under the image.
 */

/** CT presets in Hounsfield units (keys 2 to 4); key 1 is the file's own window. */
export const CT_PRESETS: Record<2 | 3 | 4, { label: string; center: number; width: number }> = {
  2: { label: 'brain', center: 40, width: 80 },
  3: { label: 'bone', center: 400, width: 1800 },
  4: { label: 'soft tissue', center: 40, width: 400 },
};

export type WindowChoice = 'file' | 'brain' | 'bone' | 'soft' | 'full' | 'custom';

/**
 * Which choice is on screen: the file's own (no window in the URL), a CT preset, the full range (not CT: the window
 * spans the image's values), else "custom" (set with the keys), which matches no option.
 */
export function windowChoice({ wc, ww, isCT, range }: { wc?: number; ww?: number; isCT: boolean; range: { min: number; max: number } | null }): WindowChoice {
  if (wc === undefined || ww === undefined) return 'file';
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-5);
  if (isCT) {
    if (near(wc, CT_PRESETS[2].center) && near(ww, CT_PRESETS[2].width)) return 'brain';
    if (near(wc, CT_PRESETS[3].center) && near(ww, CT_PRESETS[3].width)) return 'bone';
    if (near(wc, CT_PRESETS[4].center) && near(ww, CT_PRESETS[4].width)) return 'soft';
    return 'custom';
  }
  if (range && near(wc, (range.min + range.max) / 2) && near(ww, Math.max(range.max - range.min, 1))) return 'full';
  return 'custom';
}

/** Where the window on screen came from, in a few words. */
export function windowSourceWords(source: string | null | undefined): string {
  if (source === 'request') return 'set by you';
  if (source === 'file') return "the file's own";
  return "the image's full range";
}
