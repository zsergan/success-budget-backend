#!/usr/bin/env bash
set -euo pipefail

# Dumps DB_DATABASE to a timestamped, gzipped file. Uses the mysql:8 Docker
# image rather than requiring a local mysql client - works the same on any
# machine that has Docker, against any reachable MySQL (local or managed).
#
# Required env vars: DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_DATABASE
# (e.g. `set -a; source .env; set +a` first, or export them from wherever
# your hosting platform's secrets live).
#
# Optional: BACKUP_DIR (default ./backups)
#
# Usage: ./scripts/db-backup.sh

: "${DB_HOST:?DB_HOST is required}"
: "${DB_PORT:?DB_PORT is required}"
: "${DB_USERNAME:?DB_USERNAME is required}"
: "${DB_PASSWORD:?DB_PASSWORD is required}"
: "${DB_DATABASE:?DB_DATABASE is required}"

backup_dir="${BACKUP_DIR:-./backups}"
mkdir -p "$backup_dir"

# A DB_HOST of localhost/127.0.0.1 means "reachable from this machine", not
# from inside the mysqldump container - host.docker.internal is Docker's
# stand-in for "the machine running Docker" and works the same way on
# Docker Desktop (Mac/Windows) and Linux (via --add-host below). A real
# remote host (managed MySQL) is unaffected by this substitution.
docker_host="$DB_HOST"
if [[ "$docker_host" == "localhost" || "$docker_host" == "127.0.0.1" ]]; then
  docker_host="host.docker.internal"
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
out_file="$backup_dir/${DB_DATABASE}-${timestamp}.sql.gz"

# --no-tablespaces: without it, mysqldump 8.x tries to dump tablespace
# metadata first, which needs the PROCESS privilege - an app-level DB user
# (not root/admin, the norm on managed MySQL) doesn't have it, and the dump
# fails outright before writing anything.
docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -e MYSQL_PWD="$DB_PASSWORD" \
  mysql:8 \
  mysqldump \
  --host="$docker_host" \
  --port="$DB_PORT" \
  --user="$DB_USERNAME" \
  --single-transaction \
  --routines \
  --triggers \
  --no-tablespaces \
  "$DB_DATABASE" \
  | gzip > "$out_file"

echo "Backup written to $out_file"
