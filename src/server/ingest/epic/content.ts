/**
 * Which parsers read a segment (no AI): messages for a Messages section, notes (telephone notes among them) for an
 * All Encounter Notes section, letters, questionnaires, media items, and the unverified "Patient Entered
 * Data". A notes section that mixes in other kinds is read by every parser whose items it holds. Pure.
 */
import { SEGMENTER_VERSION, type ParsedSegmentContent } from '../../../shared/schemas/segments';
import type { ParseContext } from './common';
import type { SegLine } from './lines';
import { parseLetters } from './letters';
import { parseMediaItems } from './media';
import { parseMessages, parsePatientEntered } from './messages';
import { parseNotes } from './notes';
import { parseQuestionnaires } from './questionnaires';

export function parseSegmentLines(kind: string, lines: readonly SegLine[], ctx: ParseContext): ParsedSegmentContent {
  const out: ParsedSegmentContent = { segmentId: ctx.segmentId, version: SEGMENTER_VERSION, messages: [], notes: [], letters: [], questionnaires: [], media: [] };
  switch (kind) {
    case 'messages':
    case 'appointment_request':
      out.messages = parseMessages(lines, ctx);
      break;
    case 'note':
    case 'telephone':
      out.notes = parseNotes(lines, ctx);
      break;
    case 'letter':
      out.letters = parseLetters(lines, ctx);
      break;
    case 'questionnaire':
      out.questionnaires = parseQuestionnaires(lines, ctx);
      break;
    case 'media':
      out.media = parseMediaItems(lines, ctx);
      break;
    case 'patient_entered':
      out.messages = parsePatientEntered(lines, ctx);
      break;
    default:
      break;
  }
  return out;
}
