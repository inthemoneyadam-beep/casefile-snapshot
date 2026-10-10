#!/bin/sh
# CaseFile container start (Dockerfile ENTRYPOINT, under tini; docs/DEPLOY.md).
# Railway mounts the volume owned by root. Started as root, this makes the data and backups folders, hands a folder
# that is not the unprivileged "node" user's yet to that user (the first start only: a volume full of records is not
# walked again at every start), and then runs the server as "node". The server never runs as root.
# Nothing is deleted or moved here.
set -eu

if [ "$(id -u)" = "0" ]; then
  node_uid="$(id -u node)"
  for d in "${RAILWAY_VOLUME_MOUNT_PATH:-}" "${CASEFILE_DATA_DIR:-}" "${CASEFILE_BACKUPS_DIR:-}"; do
    [ -n "$d" ] || continue
    mkdir -p "$d"
    if [ "$(stat -c %u "$d")" != "$node_uid" ]; then
      echo "entrypoint: giving $d to the node user (first start on this volume)"
      chown -R node:node "$d"
    fi
  done
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
