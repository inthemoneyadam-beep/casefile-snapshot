# Hosted mode (generic deployment notes)

CaseFile normally runs on one computer (127.0.0.1). It can also run as one
private server in a container; the repository is prepared for Railway
(`Dockerfile`, `railway.json`, `scripts/docker-entrypoint.sh`), but nothing
here is specific to any one deployment.

## What hosted mode changes
- `CASEFILE_HOSTED=1` (set in the Dockerfile) turns it on. The server listens
  on `CASEFILE_HOST` (default `0.0.0.0`) and `CASEFILE_PORT`, else the
  platform's `PORT`.
- Every restart, redeploy or crash starts **locked**: the case opens only when
  someone types a passphrase. Readings run only while unlocked.
- Setting up a new case, or restoring one, needs a one-time setup code
  (`CASEFILE_SETUP_TOKEN`), so a stranger who finds the address cannot.
- A backup can be restored through the browser on the setup screen, uploaded
  in resumable 16 MB pieces, and only onto an empty server.
- No names on the lock screen; repeated wrong passphrases are throttled.
- "Import a folder" is off (there are no local folders); files are dropped or
  chosen instead.
- Sign-in cookies are HTTPS-only.

## Storage
- Attach one persistent volume and mount it at `/data`.
- Point the case and the backups inside it, e.g. `CASEFILE_DATA_DIR=/data/case`
  and `CASEFILE_BACKUPS_DIR=/data/backups`. The server refuses to start when
  either is missing or lies outside the mounted volume, so a redeploy can never
  write the case where the next one loses it.
- Everything on the volume stays encrypted (database, keyring, file store).

## Replicas and health
- Exactly **one** replica (`numReplicas: 1` in `railway.json`). The encrypted
  database and the in-memory unlock state are per process.
- Health check: `GET /healthz` (`healthcheckPath` in `railway.json`).
- No overlap between old and new deployments (`overlapSeconds: 0`), so two
  processes never open the same database.

## Variables (names only; never commit values)
| Name | What |
|---|---|
| `CASEFILE_HOSTED` | `1` for hosted mode (set in the Dockerfile) |
| `CASEFILE_DATA_DIR` | the case folder on the volume |
| `CASEFILE_BACKUPS_DIR` | the backups folder on the volume |
| `CASEFILE_SETUP_TOKEN` | the one-time setup code for setup and restore; keep it in a password manager |
| `PORT` | given by the platform |
| `TZ` | the case's local time zone (the image defaults to `UTC`; the host sets its own) |
| `ANTHROPIC_API_KEY` | optional; otherwise the key is stored in the encrypted settings |

## Before every deploy
- `npm run deploy:check` must report that nothing private would be sent
  (`.dockerignore` and `.railwayignore` keep records, data, backups, PDFs,
  databases, zips and keyrings out of the build).
- Deploy files stay LF (`.gitattributes`).
- The Docker build runs a smoke test of the hosted server
  (`scripts/container-smoke.ts`); a failure stops the build.
