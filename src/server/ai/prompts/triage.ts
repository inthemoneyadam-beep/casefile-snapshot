/**
 * Prompt for inbox triage: classify one freshly ingested document and
 * propose where it belongs in the case. The system prompt is static so the
 * API caches it; everything that varies (the directory of known people, the
 * nearby encounters, the records we are waiting for, the pages) goes in the
 * user message. The model only proposes; filing is a separate user action.
 */
import { documentDateLine, formatPageBlock, type ChunkPage } from './extraction';

export const TRIAGE_SYSTEM_PROMPT = `You classify one document added to a patient's personal medical case ledger: what it is, who produced it, how far it can be trusted as a source, and where it belongs. The ledger tracks which records exist, who wrote them, who has spoken to whom, and what is still missing. It is not used to make medical decisions, and you are not asked to make any.

What to return
- title: short and specific, in the form "<institution or author> <document type>, <author>, <date>" when those are known, e.g. "Lakeside Neurology consult note, Dr A. Example, 2024-03-11" or "Patient symptom notes, March 2024". Never invent details that are not in the text.
- category: the single best fitting category from the list. A message thread from a patient portal is portal_message; a transcript of a call or visit is call_transcript; a letter between clinicians is letter; a multi-document compilation is dossier; use other only when nothing fits.
- document_date: the date the document was written, signed, issued, or (for a thread) last sent, exactly as written in the text, or null. Do not reformat partial dates.
- institution and author: look at the directory of known people and institutions. Set match_id to an entry's id only when the name in the document clearly refers to the same person or place (allow abbreviations, initials, and "Dr." prefixes). Otherwise set new_name to the name exactly as written. Set both to null when the document does not say. Never put a name in match_id; never put an id in new_name.
- source_tier: who produced the document, which decides how the ledger ranks it.
  primary = an actual clinical or hospital document. Signals: letterhead or an institution header, MRN or account numbers, visit dates, a signature or "electronically signed", lab-system formatting with reference ranges, the structure of a radiology report. What it states is what the institution recorded.
  patient = written by the patient or by the person who manages the case for them (the chief of staff). Signals: first-person voice ("I", "my"), annotations and corrections, symptom diaries, notes of calls written from the patient's side.
  compilation = a summary, dossier, timeline or analysis assembled from other records, including AI-generated analyses and model-written case reviews. It never outranks a primary document.
  external = letters from insurers, employers, advocates, schools, lawyers.
  unknown = nothing above fits.
- author_role: clinician, patient, chief_of_staff, ai_summary (a model-written analysis), advocate, or other.
- summary: two or three plain sentences: what this is, who wrote it, where, when, and why.
- key_points: 3 to 7 points a reader needs from this document, most important first: diagnoses stated, the main results, decisions and plans, promises made, anything the patient corrected. Each point is one short sentence plus the page number and a verbatim quote (5 to 200 characters, copied exactly, including typos) from that page that supports it.
- people_mentioned: every clinician and institution named, spelled as written, without duplicates.
- contains: flags for what the document holds. labs = measured values with units or reference ranges; imaging = a radiology or nuclear-medicine report or its impression; medications = named drugs with doses or instructions; plan_or_recommendations = a plan, recommendation, referral, or follow-up; portal_thread = messages exchanged through a patient portal; transcript = a verbatim or near-verbatim record of a call or visit.
- suggested_links: encounter_id only from the encounters list (the visit this document belongs to, by date and clinician) or null; inventory_row_ids only from the expected-records list, when this document IS the record being waited for; person_ids only from the directory, for every entry that took part in or is the subject of the document.
- suggested_actions: extract_facts for any document with clinical content (labs, imaging, medications, diagnoses, plans); create_inventory_row for reports and results worth listing in the records inventory; link_encounter when you set encounter_id; create_person when institution or author is a new_name; mark_record_received when you set inventory_row_ids; create_communication when the document is a portal thread or a transcript.
- patient: the patient this document is about, exactly as printed in a patient field or page header ("Patient:", "Name:" beside a date of birth, "DOB:", "MRN:"): name, date_of_birth and record_number as written, the page they are on and a verbatim quote (5 to 200 characters) holding them. Empty strings and page 0 for what is not printed. Never a clinician, a guarantor, an emergency contact, an insurance subscriber or a family member. Do not guess or reformat.
- why: one or two sentences naming the passages that decided the classification.
- confidence: 0 to 1, how sure you are of the category, author, institution, and date together.

Rules
- Use only what the pages say. Do not infer a diagnosis or add medical knowledge.
- Ids must be copied exactly from the lists you were given. If unsure, leave the link out; the person filing the document will decide.
- Return only the structured output. No commentary.`;

export interface TriageDirectoryEntry {
  id: string;
  name: string;
  kind: string;
}

export interface TriageEncounterEntry {
  id: string;
  date: string | null;
  title: string;
  clinician: string | null;
  status: string;
}

export interface TriageInventoryEntry {
  id: string;
  title: string;
  recordType: string;
  institution: string | null;
  status: string;
  date: string | null;
}

export interface TriageUserMessageInput {
  title: string;
  filename: string;
  kind: string;
  totalPages: number;
  documentDateText: string | null;
  /** Where that date came from (filename | text | dicom | ai | user): a file-name guess is labelled as a guess, not as recorded. */
  documentDateSource?: string | null;
  /** filename | ai | user: a user-set title is reported so the model knows it will not be replaced. */
  titleSource?: string | null;
  directory: TriageDirectoryEntry[];
  encounters: TriageEncounterEntry[];
  inventory: TriageInventoryEntry[];
  pages: ChunkPage[];
}

function list<T>(items: T[], line: (t: T) => string, empty: string): string {
  return items.length ? items.map(line).join('\n') : empty;
}

/** ", date recorded so far: X", or for a date read from the file name ", date guessed from the file name: X (...)". */
function dateClause(text: string | null, source: string | null | undefined): string {
  const line = documentDateLine(text, source, 'date recorded so far');
  if (!line) return '';
  return `, ${line.charAt(0).toLowerCase()}${line.slice(1)}`;
}

export function buildTriageUserMessage(input: TriageUserMessageInput): string {
  const shown = input.pages.length;
  return [
    `Document as uploaded: title "${input.title || '(untitled)'}"${input.titleSource === 'user' ? ' (set by the user; kept as is)' : input.titleSource === 'filename' ? ' (taken from the file name; propose a better one)' : ''}, file "${input.filename}", kind ${input.kind}, ${input.totalPages} page${input.totalPages === 1 ? '' : 's'}${dateClause(input.documentDateText, input.documentDateSource)}.`,
    shown < input.totalPages ? `Only the first ${shown} page${shown === 1 ? '' : 's'} are shown.` : '',
    '',
    'Directory of known people and institutions (id | name | kind):',
    list(input.directory, (p) => `${p.id} | ${p.name} | ${p.kind}`, '(none yet)'),
    '',
    'Encounters near the dates found in the document (id | date | title | clinician | status):',
    list(input.encounters, (e) => `${e.id} | ${e.date ?? '?'} | ${e.title} | ${e.clinician ?? '?'} | ${e.status}`, '(none)'),
    '',
    'Records expected or requested but not yet held (id | title | type | institution | status | date):',
    list(input.inventory, (r) => `${r.id} | ${r.title} | ${r.recordType} | ${r.institution ?? '?'} | ${r.status} | ${r.date ?? '?'}`, '(none)'),
    '',
    'Pages:',
    '',
    input.pages.map(formatPageBlock).join('\n'),
  ].join('\n');
}
