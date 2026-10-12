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
# Optional: BACKUP_DIR (default ./backups), DB_SSL/DB_SSL_CA/
# DB_SSL_REJECT_UNAUTHORIZED (see scripts/lib/db-tls.sh and .env.example -
# same semantics as the app's own DB_SSL* handling).
#
# Usage: ./scripts/db-backup.sh

: "${DB_HOST:?DB_HOST is required}"
: "${DB_PORT:?DB_PORT is required}"
: "${DB_USERNAME:?DB_USERNAME is required}"
: "${DB_PASSWORD:?DB_PASSWORD is required}"
: "${DB_DATABASE:?DB_DATABASE is required}"

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/db-tls.sh"
db_tls_setup

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

if [[ -e "$out_file" ]]; then
  echo "Refusing to overwrite existing backup $out_file (another backup started in the same second?)" >&2
  exit 1
fi

# Dump into a private temp file first and only rename it to out_file once
# mysqldump *and* gzip have both fully succeeded - a reader must never see a
# partial or failed dump under the final name. trap covers both `set -e`
# aborting the script and an external signal (Ctrl-C, etc), and also cleans
# up the CA temp file db_tls_setup may have created for a PEM-content CA.
tmp_file="$(mktemp "$backup_dir/.${DB_DATABASE}-${timestamp}.XXXXXX")"
chmod 600 "$tmp_file"
cleanup() {
  rm -f "$tmp_file"
  db_tls_cleanup
}
trap cleanup ERR EXIT INT TERM

# --no-tablespaces: without it, mysqldump 8.x tries to dump tablespace
# metadata first, which needs the PROCESS privilege - an app-level DB user
# (not root/admin, the norm on managed MySQL) doesn't have it, and the dump
# fails outright before writing anything.
docker_args=(run --rm --add-host=host.docker.internal:host-gateway -e "MYSQL_PWD=$DB_PASSWORD")
if [[ ${#DB_TLS_DOCKER_ARGS[@]} -gt 0 ]]; then
  docker_args+=("${DB_TLS_DOCKER_ARGS[@]}")
fi
docker_args+=(
  mysql:8
  mysqldump
  --host="$docker_host"
  --port="$DB_PORT"
  --user="$DB_USERNAME"
  --single-transaction
  --routines
  --triggers
  --no-tablespaces
)
if [[ ${#DB_TLS_MYSQL_ARGS[@]} -gt 0 ]]; then
  docker_args+=("${DB_TLS_MYSQL_ARGS[@]}")
fi
docker_args+=("$DB_DATABASE")

docker "${docker_args[@]}" | gzip > "$tmp_file"

# -n: never clobber - if out_file appeared while we were dumping (a
# concurrent backup that started in the same second), keep both dumps
# intact instead of silently overwriting one of them.
mv -n "$tmp_file" "$out_file"
if [[ -e "$tmp_file" ]]; then
  echo "Backup target $out_file already existed when the dump finished - refusing to overwrite it" >&2
  exit 1
fi

trap - ERR EXIT INT TERM
db_tls_cleanup

if [[ ! -e "$out_file" ]]; then
  echo "Backup did not produce $out_file" >&2
  exit 1
fi

echo "Backup written to $out_file"
