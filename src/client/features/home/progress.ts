/** Where a document is in Claude's reading, in plain words. */
export function documentProgressWords(textStatus: string, extractionStatus: string): string {
  if (textStatus === 'pending' || textStatus === 'extracting') return 'Reading…';
  if (textStatus === 'ocr_needed') return 'Scanned pages: needs a closer read';
  if (textStatus === 'ocr_running') return 'Reading the scanned pages…';
  if (textStatus === 'failed') return 'Could not be read';
  if (extractionStatus === 'queued' || extractionStatus === 'running') return 'Pulling out details…';
  if (extractionStatus === 'failed') return 'Details could not be pulled out';
  if (extractionStatus === 'done') return 'Ready';
  return 'Details not pulled out yet';
}
