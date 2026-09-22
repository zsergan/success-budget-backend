#!/usr/bin/env bash
set -euo pipefail

# Restores a backup produced by db-backup.sh into DB_DATABASE. Point this at
# a NEW or empty database - it does not drop or truncate anything first, so
# restoring on top of a live database will conflict with existing rows
# instead of cleanly replacing them. See docs/deployment.md for the full
# restore procedure (why a *new* database, not the live one).
#
# Required env vars: DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_DATABASE
#
# Usage: ./scripts/db-restore.sh path/to/backup.sql.gz

: "${DB_HOST:?DB_HOST is required}"
: "${DB_PORT:?DB_PORT is required}"
: "${DB_USERNAME:?DB_USERNAME is required}"
: "${DB_PASSWORD:?DB_PASSWORD is required}"
: "${DB_DATABASE:?DB_DATABASE is required}"

dump_file="${1:?Usage: $0 path/to/backup.sql.gz}"

if [[ ! -f "$dump_file" ]]; then
  echo "No such file: $dump_file" >&2
  exit 1
fi

# See db-backup.sh for why localhost/127.0.0.1 needs this substitution.
docker_host="$DB_HOST"
if [[ "$docker_host" == "localhost" || "$docker_host" == "127.0.0.1" ]]; then
  docker_host="host.docker.internal"
fi

gunzip -c "$dump_file" | docker run --rm -i \
  --add-host=host.docker.internal:host-gateway \
  -e MYSQL_PWD="$DB_PASSWORD" \
  mysql:8 \
  mysql \
  --host="$docker_host" \
  --port="$DB_PORT" \
  --user="$DB_USERNAME" \
  "$DB_DATABASE"

echo "Restored $dump_file into $DB_DATABASE"
