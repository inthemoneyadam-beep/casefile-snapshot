/**
 * Job handler registry. Each handler module exports a function and is
 * registered here once at startup.
 *
 * 2026-10-07 (large exports): `segment_document` cuts a document into segments (and keeps what a reading before
 * segments proved read), `resume_extraction` carries a stopped reading on, `rules_after_ingest` runs the deterministic
 * rules once after readings (debounced by the queue). A cancelled extraction puts its document's status back.
 */
import { onExtractionJobCancelled, registerJobHandler } from './queue';
import { ingestDocumentJob } from '../ingest/pipeline';
import { extractFactsJob, resetStatusAfterCancel, resumeExtractionJob } from '../ai/extraction';
import { crossrefJob } from '../ai/crossref';
import { exportPacketJob } from '../export/packet';
import { triageDocumentJob } from '../ingest/triage';
import { segmentDocumentAndAdoptJob } from '../services/reprocess';
import { rulesAfterIngestJob } from '../services/ingest-hooks';
import { guardedJob } from '../services/patient-check';
import { readPlanJob, type ReadPlanPayload } from '../services/plans';
import { readNotesJob } from '../services/notes-reading';
import { selfCheckJob } from '../services/self-check';

export function registerAllJobHandlers(): void {
  registerJobHandler('ingest_document', ingestDocumentJob);
  registerJobHandler('reingest_document', ingestDocumentJob);
  // The wrong-patient guard (2026-10-09): a document never checked against Patient details is checked before it is
  // read or sorted; one held back as someone else's record is not read.
  registerJobHandler('extract_facts', guardedJob(extractFactsJob));
  registerJobHandler('resume_extraction', guardedJob(resumeExtractionJob));
  registerJobHandler('segment_document', segmentDocumentAndAdoptJob);
  registerJobHandler('rules_after_ingest', rulesAfterIngestJob);
  registerJobHandler('crossref', crossrefJob);
  registerJobHandler('export_packet', exportPacketJob);
  registerJobHandler('triage_document', guardedJob(triageDocumentJob));
  // 2026-10-09: the Plan page. The job checks the patient itself, once the upload's pages are stored.
  registerJobHandler<ReadPlanPayload>('read_plan', (ctx) => readPlanJob(ctx));
  // My notes (2026-10-09): several short notes read in one call; each note is checked against Patient details first.
  registerJobHandler('read_notes', readNotesJob);
  // Checked against itself (2026-10-09): a document's lab flags (no AI), then its parts read for contradictions.
  registerJobHandler('self_check', guardedJob(selfCheckJob));
  onExtractionJobCancelled(resetStatusAfterCancel);
}
