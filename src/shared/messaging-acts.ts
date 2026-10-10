/**
 * Messaging acts (2026-10-07, findings D.1.6): an `event` that only says a message, call, questionnaire or letter
 * happened ("Patient sent a MyChart message to Dr. X", "Nurse returned the patient's call") is not a fact: the message
 * itself is read into Calls & Messages. One test, shared by the extraction engine (new facts read from messages and
 * calls) and the one-time clean-up of facts read before (services/messages-import.ts).
 *
 * Anything clinical stays a fact (2026-10-07 review, rev-comms #8): a statement that says more than the act (after a
 * colon, a number that is not its date or time, a dose or unit, something scheduled, approved, denied, started or
 * stopped, a result) is never a messaging act ("Nurse returned the call: the MRI is scheduled for 4/12").
 */

const MESSAGING_VERB = /\b(sent|sends|send|sending|replied|replies|reply|responded|responds|read|viewed|opened|messaged|messages|wrote|writes|called|calls|phoned|returned|left|submitted|submits|scheduled|canceled|cancelled|rescheduled|received|delivered)\b/i;
const MESSAGING_OBJECT = /\b(portal|mychart|my chart|message|messages|reply|call|calls|phone|telephone|voicemail|voice mail|questionnaire|appointment request|letter)\b/i;

/** Dates and times a messaging act may carry ("on 7/16/2030 at 9:41 AM", "2030-07-16", "Jul 16", "at 0941"). */
const DATE_OR_TIME = [
  /\b\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?\b/g,
  /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g,
  /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?\s*m\.?)?/gi,
  /\b\d{1,2}\s*[ap]\.?\s*m\.?(?![a-z])/gi,
  /\b(?:at|@)\s*\d{3,4}\b/gi,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/gi,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:,?\s+\d{4})?\b/gi,
  /\b(?:19|20)\d{2}\b/g,
];

/** Words that say what was decided or found, beyond the message or call itself. */
const CLINICAL_WORDS = /\b(mg|mcg|µg|ug|ml|mL|units?|iu|dose|doses|dosage|tablets?|tabs?|capsules?|scheduled|approved|denied|declined|results?|normal|abnormal|positive|negative|started|stopped|starting|stopping|increased?|decreased?|tapers?|tapering|prescribed|prescription|refills?|diagnos\w*|admitted|admission|discharged|referred|referral|ordered|orders?)\b/i;

/** True when a statement says something beyond the act itself (see the module comment). */
export function hasClinicalContent(text: string): boolean {
  let rest = text;
  for (const re of DATE_OR_TIME) rest = rest.replace(re, ' ');
  if (rest.includes(':')) return true;
  if (/\d/.test(rest)) return true;
  return CLINICAL_WORDS.test(rest);
}

/** True for an event that only says a message, call, questionnaire or letter happened (see the module comment). */
export function isMessagingActText(type: string, name: string | null | undefined, statement: string): boolean {
  if (type !== 'event') return false;
  const text = `${typeof name === 'string' ? name : ''} ${statement}`;
  if (!MESSAGING_VERB.test(text) || !MESSAGING_OBJECT.test(text)) return false;
  return !hasClinicalContent(text);
}
