/**
 * /print/emergency-card — one printable Letter page: patient header, the
 * NEVER GIVE box, other intolerances, current medications, confirmed
 * diagnoses, key contacts, summary. Adds `print-view` to body while mounted
 * so print.css lays it out; `p` prints.
 */
import { useEffect } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEmergencyCard } from '../api/medications';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { Button } from '../ui/Button';
import { Kbd } from '../ui/Kbd';
import { DateText } from '../ui/DateText';
import { MED_STATUS_WORDS } from '../ui/StatusTag';
import { intoleranceKindWords, severityWords } from '../features/medications/words';
import { personKindWords } from '../features/people/shared';
import '../features/medications/medications.css';

export const Route = createFileRoute('/print/emergency-card')({ component: EmergencyCardPage });

function fmtStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A row accepted from a fact the patient has not yet confirmed (the citation may not have been checked). */
function UnconfirmedSource({ status }: { status: string | null | undefined }) {
  return status === 'unverified' ? <span className="faint"> (source not yet confirmed)</span> : null;
}

function EmergencyCardPage() {
  const card = useEmergencyCard();
  useEffect(() => {
    document.body.classList.add('print-view');
    return () => document.body.classList.remove('print-view');
  }, []);
  useBindings([{ keys: 'p', description: 'Print the emergency card', group: 'Page', run: () => window.print() }], []);
  useRegisterCommands([{ id: 'print.emergency-card', title: 'Print emergency card', group: 'Page', shortcut: 'p', run: () => window.print() }], []);

  const c = card.data;
  // Columns no row fills are left off the printed card: an empty Route or Prescriber column squeezed doses and phone
  // numbers onto two lines ("150 / mg", "555- / 0101").
  const meds = c?.activeMedications ?? [];
  const showRoute = meds.some((m) => Boolean(m.route));
  const showFor = meds.some((m) => Boolean(m.indication));
  const showFrequency = meds.some((m) => Boolean(m.frequency));
  const showPrescriber = meds.some((m) => Boolean(m.prescriberName));
  const contacts = c?.keyContacts ?? [];
  const showInstitution = contacts.some((k) => Boolean(k.institutionName));
  const showEmail = contacts.some((k) => Boolean(k.email ?? k.fax));
  return (
    <div className="page">
      <div className="page-body">
        <div className="printable ec">
          <div className="ec-tools no-print">
            <Button size="sm" variant="primary" onClick={() => window.print()} shortcut="p">
              Print
            </Button>
            <Link to="/medications">Back to Medications</Link>
            <span>Letter, portrait. Patient details come from Settings; drugs never to give and medications from Medications; diagnoses from the ones you checked in Details from documents.</span>
            <span>
              <Kbd>g m</Kbd> medications
            </span>
          </div>

          {card.isPending ? (
            <div className="muted small">Loading…</div>
          ) : card.isError || !c ? (
            <div className="notice bad">Could not load the emergency card{card.error instanceof Error ? `: ${card.error.message}` : ''}.</div>
          ) : (
            <>
              <h1>Emergency card</h1>
              <div className="ec-head">
                <div>
                  <div className="ec-patient">{c.patient.name || <span className="faint">Patient name not set (Settings → Patient details)</span>}</div>
                  <div className="meta">Carry this card. It summarises what a treating team must know first.</div>
                </div>
                <dl className="ec-facts">
                  <dt>Date of birth</dt>
                  <dd>{c.patient.dob || <span className="ec-empty">not set</span>}</dd>
                  <dt>Blood type</dt>
                  <dd>{c.patient.bloodType || <span className="ec-empty">not set</span>}</dd>
                  <dt>Generated</dt>
                  <dd>{fmtStamp(c.generatedAt)}</dd>
                </dl>
              </div>

              <div className="hardstop" role="alert">
                <strong>Never give</strong>
                {c.hardStops.length ? (
                  <table>
                    <tbody>
                      {c.hardStops.map((h) => (
                        <tr key={h.id}>
                          <td className="big" style={{ width: '32%' }}>
                            {h.substance}
                          </td>
                          <td>{h.reaction ?? <span className="ec-empty">reaction not recorded</span>}</td>
                          <td style={{ width: '18%' }}>{h.severity !== 'unknown' ? severityWords(h.severity) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="ec-empty">None recorded.</div>
                )}
              </div>

              <h2>Other allergies and intolerances</h2>
              {c.intolerances.length ? (
                <table>
                  <thead>
                    <tr>
                      <th>Substance</th>
                      <th>Kind</th>
                      <th>Severity</th>
                      <th>Reaction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.intolerances.map((i) => (
                      <tr key={i.id}>
                        <td>
                          {i.substance}
                          <UnconfirmedSource status={i.sourceFact && !i.sourceFact.deleted ? i.sourceFact.status : null} />
                        </td>
                        <td>{intoleranceKindWords(i.kind)}</td>
                        <td>{i.severity === 'unknown' ? '' : severityWords(i.severity)}</td>
                        <td>{i.reaction ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="ec-empty">None recorded.</div>
              )}

              <h2>Current medications</h2>
              {c.activeMedications.length ? (
                <table>
                  <thead>
                    <tr>
                      <th>Medication</th>
                      <th>Dose</th>
                      {showRoute ? <th>Route</th> : null}
                      {showFrequency ? <th>Frequency</th> : null}
                      {showFor ? <th>For</th> : null}
                      {showPrescriber ? <th>Prescriber</th> : null}
                      <th>Since</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.activeMedications.map((m) => (
                      <tr key={m.id}>
                        <td>
                          {m.name}
                          {m.status !== 'active' ? <span className="faint"> ({MED_STATUS_WORDS[m.status] ?? m.status.replace(/_/g, ' ')})</span> : null}
                          <UnconfirmedSource status={m.sourceFactStatus} />
                        </td>
                        <td className="mono">{[m.dose, m.unit].filter(Boolean).join(' ')}</td>
                        {showRoute ? <td>{m.route ?? ''}</td> : null}
                        {showFrequency ? <td>{m.frequency ?? ''}</td> : null}
                        {showFor ? <td>{m.indication ?? ''}</td> : null}
                        {showPrescriber ? <td>{m.prescriberName ?? ''}</td> : null}
                        <td>{m.startDate || m.startDateText ? <DateText iso={m.startDate} precision={m.startDatePrecision} text={m.startDateText} /> : <span className="ec-empty">not recorded</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="ec-empty">No current medications recorded.</div>
              )}

              <h2>Diagnoses (confirmed)</h2>
              {c.diagnoses.length ? (
                <table>
                  <tbody>
                    {c.diagnoses.map((dx) => (
                      <tr key={dx.id}>
                        <td style={{ width: '28%' }}>{dx.name ?? dx.statement}</td>
                        <td>
                          {dx.name ? dx.statement : ''}
                          {dx.certainty && dx.certainty !== 'confirmed' ? <span className="faint"> ({dx.certainty.replace(/_/g, ' ')})</span> : null}
                        </td>
                        <td style={{ width: '22%' }}>
                          {dx.statedBy ?? ''}
                          {dx.date ? (
                            <span className="faint">
                              {dx.statedBy ? ', ' : ''}
                              <DateText iso={dx.date} precision={dx.datePrecision} text={dx.dateText} />
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="ec-empty">None confirmed.</div>
              )}

              <h2>Key contacts</h2>
              {c.keyContacts.length ? (
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Role</th>
                      {showInstitution ? <th>Institution</th> : null}
                      <th>Phone</th>
                      {showEmail ? <th>Email / fax</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {c.keyContacts.map((k) => (
                      <tr key={k.id}>
                        <td>{k.name}</td>
                        {/* The People page's words for a place with no role ("Clinic", "Hospital or institution"), never the stored kind. */}
                        <td>{k.role ?? k.specialty ?? personKindWords(k.kind)}</td>
                        {showInstitution ? <td>{k.institutionName ?? ''}</td> : null}
                        <td className="mono">{k.phone ?? ''}</td>
                        {showEmail ? <td className="mono">{k.email ?? k.fax ?? ''}</td> : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="ec-empty">No people with a phone, fax or email yet.</div>
              )}

              {c.patient.emergencyContactLines.length ? (
                <>
                  <h2>Emergency contacts</h2>
                  <div className="ec-contacts">
                    {c.patient.emergencyContactLines.map((line, i) => (
                      <div key={i}>{line}</div>
                    ))}
                  </div>
                </>
              ) : null}

              <h2>Summary</h2>
              {c.patient.summary ? <p className="ec-summary">{c.patient.summary}</p> : <div className="ec-empty">No summary yet. Write one paragraph in Settings → Patient details: what a stranger in an emergency department should read first.</div>}

              <div className="footer">
                Generated by CaseFile on {fmtStamp(c.generatedAt)} from the patient's own case file. Never-give drugs and medications are as recorded there; rows marked (source not yet confirmed) were taken from a record extract the patient has not yet reviewed. Diagnoses are only those the patient confirmed. Verify against current records before acting.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
