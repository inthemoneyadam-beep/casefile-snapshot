/**
 * API route table. Each feature owns one file in this directory and exports a
 * Hono sub-app. Add new features here; keep the paths flat and plural.
 */
import { Hono } from 'hono';
import { settingsRoutes } from './settings';
import { jobsRoutes } from './jobs';
import { aiRoutes } from './ai';
import { systemRoutes } from './system';
import { documentsRoutes } from './documents';
import { factsRoutes } from './facts';
import { peopleRoutes } from './people';
import { communicationsRoutes } from './communications';
import { recordsRoutes } from './records';
import { timelineRoutes } from './timeline';
import { encountersRoutes } from './encounters';
import { medicationsRoutes } from './medications';
import { symptomsRoutes } from './symptoms';
import { labsRoutes } from './labs';
import { imagingRoutes } from './imaging';
import { tasksRoutes } from './tasks';
import { findingsRoutes } from './findings';
import { askRoutes } from './ask';
import { exportRoutes } from './export';
import { searchRoutes } from './search';
import { inboxRoutes } from './inbox';
import { usersRoutes } from './users';
import { dicomRoutes } from './dicom';
import { importRoutes } from './import';
import { filingRoutes } from './filing';
import { reconcileRoutes } from './reconcile';
import { patientCheckRoutes } from './patient-check';
import { plansRoutes } from './plans';
import { notesRoutes } from './notes';
import { selfCheckRoutes } from './self-check';
import { careTeamRoutes } from './care-team';

export const apiRoutes = new Hono()
  .route('/settings', settingsRoutes)
  .route('/jobs', jobsRoutes)
  .route('/ai', aiRoutes)
  .route('/system', systemRoutes)
  .route('/documents', documentsRoutes)
  .route('/facts', factsRoutes)
  .route('/people', peopleRoutes)
  .route('/communications', communicationsRoutes)
  .route('/records', recordsRoutes)
  .route('/timeline', timelineRoutes)
  .route('/encounters', encountersRoutes)
  .route('/medications', medicationsRoutes)
  .route('/symptoms', symptomsRoutes)
  .route('/labs', labsRoutes)
  .route('/imaging', imagingRoutes)
  .route('/tasks', tasksRoutes)
  .route('/findings', findingsRoutes)
  .route('/ask', askRoutes)
  .route('/export', exportRoutes)
  .route('/search', searchRoutes)
  .route('/inbox', inboxRoutes)
  .route('/users', usersRoutes)
  .route('/dicom', dicomRoutes)
  .route('/import', importRoutes)
  .route('/filing', filingRoutes)
  .route('/reconcile', reconcileRoutes)
  .route('/patient-check', patientCheckRoutes)
  .route('/plans', plansRoutes)
  .route('/notes', notesRoutes)
  .route('/self-check', selfCheckRoutes)
  .route('/care-team', careTeamRoutes);
