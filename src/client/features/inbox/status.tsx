import { Tag, type TagTone } from '../../ui/StatusTag';
import { isReading, type InboxItem } from '../../api/inbox';

type StatusFields = Pick<InboxItem, 'inbox' | 'textStatus' | 'textError' | 'pageCount'>;

/**
 * Where an upload stands, as a tag in plain words (never the stored status): reading it, Claude is looking at it, a
 * suggestion is ready, to file by hand (no suggestion), could not be read, filed, skipped.
 */
export function inboxStatusLabel(item: StatusFields): { label: string; tone: TagTone; title: string } {
  if (!item.inbox) return { label: 'already filed', tone: 'ash', title: 'A document already in the case; it is not waiting here' };
  switch (item.inbox.status) {
    case 'new':
      if (item.textStatus === 'failed') return { label: 'could not be read', tone: 'bad', title: 'The text could not be read from the file' };
      if (item.textStatus === 'pending' && item.textError) return { label: 'reading stopped', tone: 'bad', title: 'Reading the text stopped before it finished' };
      if (!item.pageCount || isReading(item)) return { label: 'reading', tone: 'info', title: 'The pages are being read' };
      return { label: 'Claude is looking', tone: 'info', title: 'Claude is working out where it goes' };
    case 'triaged':
      return isReading(item) ? { label: 'reading', tone: 'info', title: 'The pages are being read again' } : { label: 'suggestion ready', tone: 'warn', title: "Claude's suggestion is ready: check it, then File it" };
    case 'needs_manual':
      return isReading(item) ? { label: 'reading', tone: 'info', title: 'The pages are being read again' } : { label: 'to file by hand', tone: 'warn', title: 'No suggestion from Claude: fill in where it goes and File it' };
    case 'filed':
      return { label: 'filed', tone: 'ok', title: 'Filed; it is in Documents' };
    case 'skipped':
      return { label: 'skipped', tone: 'ash', title: 'Skipped: it stays in Documents as it is' };
    default:
      return { label: String(item.inbox.status).replace(/_/g, ' '), tone: 'neutral', title: '' };
  }
}

export function InboxStatusTag({ item }: { item: StatusFields }) {
  const { label, tone, title } = inboxStatusLabel(item);
  return (
    <Tag tone={tone} title={title || undefined}>
      {label}
    </Tag>
  );
}
