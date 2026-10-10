/**
 * Non-paginated formats: plain text, DOCX, CSV, JSON, transcripts. Their
 * text is split into pseudo-pages at paragraph boundaries so citations have
 * a page to point into.
 */
import mammoth from 'mammoth';
import * as PapaNs from 'papaparse';

export const PSEUDO_PAGE_CHARS = 3500;

// papaparse ships a UMD build; under Node ESM the API lives on `default`.
const Papa = ((PapaNs as unknown as { default?: typeof PapaNs }).default ?? PapaNs) as typeof PapaNs;

export function decodeText(buffer: Buffer): string {
  let s: string;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) s = buffer.subarray(2).toString('utf16le');
  else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) s = Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  else s = buffer.toString('utf8');
  return normalizeText(s);
}

export function normalizeText(s: string): string {
  return s.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trimEnd();
}

/**
 * Split text into pages of about `target` characters without breaking a
 * paragraph; oversized paragraphs are split at line, then sentence, then
 * character boundaries. Always returns at least one page.
 */
export function splitPseudoPages(text: string, target = PSEUDO_PAGE_CHARS): string[] {
  const norm = normalizeText(text);
  if (!norm.trim()) return [''];
  const pages: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur.trim()) pages.push(cur);
    cur = '';
  };
  const paragraphs = norm.split(/\n[ \t]*\n/);
  for (const para of paragraphs) {
    if (!para.trim()) continue;
    if (para.length > target * 1.5) {
      flush();
      for (const chunk of splitLong(para, target)) pages.push(chunk);
      continue;
    }
    if (cur && cur.length + 2 + para.length > target) flush();
    cur = cur ? `${cur}\n\n${para}` : para;
  }
  flush();
  return pages.length ? pages : [''];
}

function splitLong(para: string, target: number): string[] {
  const out: string[] = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) out.push(cur);
    cur = '';
  };
  const units = para.includes('\n') ? para.split('\n').map((l) => `${l}\n`) : para.split(/(?<=[.!?])\s+/).map((s) => `${s} `);
  for (let unit of units) {
    while (unit.length > target) {
      push();
      out.push(unit.slice(0, target));
      unit = unit.slice(target);
    }
    if (cur && cur.length + unit.length > target) push();
    cur += unit;
  }
  push();
  return out.map((s) => s.replace(/\s+$/, ''));
}

export async function docxToText(buffer: Buffer): Promise<string> {
  const r = await mammoth.extractRawText({ buffer });
  return normalizeText(r.value ?? '');
}

/** CSV/TSV as tab-separated lines; the first row is kept as the header line. */
export function csvToText(text: string): string {
  const parsed = Papa.parse<string[]>(normalizeText(text), { skipEmptyLines: true });
  const rows = (parsed.data ?? []).filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''));
  if (!rows.length) return '';
  const lines = rows.map((r) => r.map((c) => String(c ?? '').replace(/\t/g, ' ').trim()).join('\t'));
  return lines.join('\n');
}

export function jsonToText(text: string): string {
  const raw = normalizeText(text);
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
