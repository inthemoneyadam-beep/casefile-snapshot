/**
 * Identity of pages and passages (findings D.1.5): the normalised body text (furniture removed; a section heading's
 * "(continued)" dropped, since only the page it falls on differs) PLUS the digests of the images on it. Two Media pages
 * whose text is the same header-only print but whose scans differ are different pages; only an image-free page may be
 * skipped as the twin of another, and the skip names its twin. Pure.
 */
import { canSkipAsDuplicate, pageIdentityHash, segmentHashOf } from '../../../shared/schemas/segments';
import type { SegLine } from './lines';
import { isEmptyLine, sectionHeading } from './sections';

/** A line as it counts for identity: a heading's " (continued)" dropped. */
export function identityLine(line: Pick<SegLine, 'text' | 'x0' | 'parts'>): string {
  const h = sectionHeading({ text: line.text, x0: line.x0, parts: line.parts.length }) ?? sectionHeading({ text: line.text, x0: line.x0, parts: line.parts.length }, { patientBlock: true });
  return h ? h.name : line.text;
}

/** The body text compared for identity. */
export function identityBody(lines: readonly Pick<SegLine, 'text' | 'x0' | 'parts'>[]): string {
  return lines.map(identityLine).join('\n');
}

/** A page's (or a passage's) identity hash. */
export function identityHash(lines: readonly Pick<SegLine, 'text' | 'x0' | 'parts'>[], imageDigests: readonly string[] = [], ocrText: string | null = null): string {
  const body = identityBody(lines);
  return pageIdentityHash(ocrText ? `${body}\n${ocrText}` : body, imageDigests);
}

/** A passage's text_hash from the identities of its pieces, one per page, in page order. */
export function passageHash(pieces: readonly string[]): string {
  return segmentHashOf(pieces);
}

/** Content lines: neither a section heading nor an empty marker ("No documentation."). */
export function contentLines<T extends Pick<SegLine, 'text' | 'x0' | 'parts'>>(lines: readonly T[]): T[] {
  return lines.filter((l) => {
    if (isEmptyLine(l.text)) return false;
    const h = sectionHeading({ text: l.text, x0: l.x0, parts: l.parts.length }) ?? sectionHeading({ text: l.text, x0: l.x0, parts: l.parts.length }, { patientBlock: true });
    return !h;
  });
}

/** A page may be skipped as a repeat of another only when it carries no image. */
export function mayBeTwin(page: { imageDigests?: readonly string[]; imageCoverage?: number }): boolean {
  return canSkipAsDuplicate(page);
}

/** Line-set similarity (Jaccard of the distinct normalised lines), for near-twin blocks such as repeated facesheets. */
export function lineSetSimilarity(a: readonly string[], b: readonly string[]): number {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const A = new Set(a.map(norm).filter(Boolean));
  const B = new Set(b.map(norm).filter(Boolean));
  if (!A.size && !B.size) return 1;
  let both = 0;
  for (const x of A) if (B.has(x)) both++;
  return both / (A.size + B.size - both);
}
