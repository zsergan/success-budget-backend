#!/usr/bin/env bash
set -euo pipefail

# Restores a backup produced by db-backup.sh into DB_DATABASE. Point this at
# a NEW, empty database - a standard mysqldump is not restore-safe against a
# live one: mysqldump's default --opt group includes --add-drop-table, so
# the dump itself contains `DROP TABLE IF EXISTS` before every `CREATE
# TABLE` and importing it can drop and replace tables that already exist,
# not just add to them. This script refuses to run against a non-empty
# database rather than relying on that being safe. See docs/deployment.md
# for the full restore procedure (why a *new* database, not the live one).
#
# Required env vars: DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_DATABASE
# Optional: DB_SSL/DB_SSL_CA/DB_SSL_REJECT_UNAUTHORIZED (see
# scripts/lib/db-tls.sh and .env.example - same semantics as the app's own
# DB_SSL* handling).
#
# Usage: ./scripts/db-restore.sh path/to/backup.sql.gz

: "${DB_HOST:?DB_HOST is required}"
: "${DB_PORT:?DB_PORT is required}"
: "${DB_USERNAME:?DB_USERNAME is required}"
: "${DB_PASSWORD:?DB_PASSWORD is required}"
: "${DB_DATABASE:?DB_DATABASE is required}"

dump_file="${1:?Usage: $0 path/to/backup.sql.gz}"

if [[ ! -r "$dump_file" ]]; then
  echo "Cannot read $dump_file (missing or no permission)" >&2
  exit 1
fi

if ! gzip -t "$dump_file" 2>/dev/null; then
  echo "$dump_file failed gzip integrity check (corrupted or not a valid .sql.gz backup) - refusing to restore" >&2
  exit 1
fi

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/db-tls.sh"
db_tls_setup
trap db_tls_cleanup ERR EXIT INT TERM

# See db-backup.sh for why localhost/127.0.0.1 needs this substitution.
docker_host="$DB_HOST"
if [[ "$docker_host" == "localhost" || "$docker_host" == "127.0.0.1" ]]; then
  docker_host="host.docker.internal"
fi

run_mysql() {
  local docker_args=(run --rm -i --add-host=host.docker.internal:host-gateway -e "MYSQL_PWD=$DB_PASSWORD")
  if [[ ${#DB_TLS_DOCKER_ARGS[@]} -gt 0 ]]; then
    docker_args+=("${DB_TLS_DOCKER_ARGS[@]}")
  fi
  docker_args+=(mysql:8 mysql --host="$docker_host" --port="$DB_PORT" --user="$DB_USERNAME")
  if [[ ${#DB_TLS_MYSQL_ARGS[@]} -gt 0 ]]; then
    docker_args+=("${DB_TLS_MYSQL_ARGS[@]}")
  fi
  docker_args+=("$@")
  docker "${docker_args[@]}"
}

db_exists="$(run_mysql --silent --raw --skip-column-names \
  -e "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = '${DB_DATABASE}'")"
if [[ "$db_exists" != "1" ]]; then
  echo "Database $DB_DATABASE does not exist - create it first, this script will not create it for you" >&2
  exit 1
fi

# information_schema.tables also lists views (TABLE_TYPE='VIEW'), so this
# one count covers both tables and views.
object_count="$(run_mysql --silent --raw --skip-column-names \
  -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '${DB_DATABASE}'")"
if [[ "$object_count" != "0" ]]; then
  echo "Database $DB_DATABASE is not empty ($object_count table(s)/view(s) found) - refusing to restore on top of existing data" >&2
  exit 1
fi

if gunzip -c "$dump_file" | run_mysql "$DB_DATABASE"; then
  echo "Restored $dump_file into $DB_DATABASE"
else
  echo "Import into $DB_DATABASE failed partway through - it may now contain a partial restore. Not cleaned up automatically: inspect it, and drop/recreate the database before retrying." >&2
  exit 1
fi
